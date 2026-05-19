const express = require('express');
const ccxt = require('ccxt');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios'); // Add this for payment check
const app = express();

app.use(cors());
app.use(express.json());

// Supabase connection (key from environment variable)
const SUPABASE_URL = 'https://pccuhtlfnfvyitioobko.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Your TON wallet address
const YOUR_WALLET = 'UQD3d5ZMqpheS51qbgB3A04jrf3pI2V0vXffr3Lu1rbEy7wF';

// Store price history
const priceHistory = {};

// ============ PRICE CACHE (30 seconds TTL) ============
const priceCache = {
  data: {},
  ttl: 30000,
  
  get(exchange, symbol) {
    const key = `${exchange}:${symbol}`;
    const cached = this.data[key];
    if (cached && (Date.now() - cached.timestamp) < this.ttl) {
      return cached.price;
    }
    return null;
  },
  
  set(exchange, symbol, price) {
    const key = `${exchange}:${symbol}`;
    this.data[key] = { price, timestamp: Date.now() };
  }
};

function getPriceFromMinutesAgo(symbol, minutes) {
  const now = Date.now();
  const cutoff = now - (minutes * 60 * 1000);
  if (!priceHistory[symbol]) return null;
  for (let i = priceHistory[symbol].length - 1; i >= 0; i--) {
    if (priceHistory[symbol][i].timestamp <= cutoff) {
      return priceHistory[symbol][i].price;
    }
  }
  return null;
}

function addToPriceHistory(symbol, price) {
  if (!priceHistory[symbol]) priceHistory[symbol] = [];
  priceHistory[symbol].push({ timestamp: Date.now(), price: price });
  const cutoff = Date.now() - (60 * 60 * 1000);
  priceHistory[symbol] = priceHistory[symbol].filter(p => p.timestamp > cutoff);
}

async function executeStrategy(userId, exchangeId, action, symbol, savedAmount) {
  try {
    const feeDue = savedAmount * 0.1;
    const netSaved = savedAmount - feeDue;
    await supabase.from('panic_logs').insert({
      user_id: userId,
      exchange: exchangeId,
      saved_amount: savedAmount,
      fee_due: feeDue,
      net_saved: netSaved,
      timestamp: new Date()
    });
    console.log(`✅ Saved user ${userId}: $${savedAmount}, Fee: $${feeDue}`);
  } catch (error) {
    console.log(`❌ Failed:`, error.message);
  }
}

// ============ PAYMENT CHECK ENDPOINT ============

app.get('/api/check-payment/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Check TON blockchain for payment
    const url = `https://toncenter.com/api/v2/getTransactions?address=${YOUR_WALLET}&limit=30`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    for (const tx of data.result || []) {
      const txStr = JSON.stringify(tx).toLowerCase();
      if (txStr.includes(userId.toLowerCase())) {
        // Payment found - unlock user
        await supabase.from('users').update({
          guard_locked: false,
          fee_paid: true,
          last_payment: new Date()
        }).eq('user_id', userId);
        
        // Reactivate strategies
        await supabase.from('strategies').update({
          is_active: true
        }).eq('user_id', userId);
        
        return res.json({ paid: true, message: 'Payment confirmed! Guard unlocked.' });
      }
    }
    
    return res.json({ paid: false, message: 'Payment not found yet.' });
  } catch (error) {
    console.error('Payment check error:', error.message);
    return res.json({ paid: false, message: 'Error checking payment. Try again.' });
  }
});

// ============ AUTOMATIC PRICE MONITORING ============

async function monitorPrices() {
  const now = new Date();
  console.log(`🔍 [${now.toISOString()}] Checking prices...`);
  
  const { data: strategies, error } = await supabase
    .from('strategies')
    .select('*')
    .eq('is_active', true)
    .lt('last_checked', new Date(Date.now() - 5 * 60 * 1000).toISOString());
  
  if (error) {
    console.log('Error fetching strategies:', error.message);
    return;
  }
  
  if (!strategies || strategies.length === 0) {
    console.log('No active strategies to check');
    return;
  }
  
  console.log(`📋 Checking ${strategies.length} active strategies`);
  
  const exchanges = ['binance', 'bybit', 'okx'];
  
  const neededAssets = new Set();
  for (const strategy of strategies) {
    if (strategy.parsed_strategy && strategy.parsed_strategy.asset) {
      neededAssets.add(strategy.parsed_strategy.asset);
    }
  }
  
  const neededSymbols = [];
  for (const asset of neededAssets) {
    neededSymbols.push(`${asset}/USDT`);
  }
  
  if (neededSymbols.length === 0) {
    console.log('No assets to monitor');
    return;
  }
  
  console.log(`📊 Need prices for: ${neededSymbols.join(', ')}`);

  for (const exchangeId of exchanges) {
    try {
      const exchange = new ccxt[exchangeId]();
      exchange.enableRateLimit = true;
      
      for (const symbol of neededSymbols) {
        let currentPrice = priceCache.get(exchangeId, symbol);
        
        if (currentPrice === null) {
          try {
            const ticker = await exchange.fetchTicker(symbol);
            currentPrice = ticker.last;
            priceCache.set(exchangeId, symbol, currentPrice);
            console.log(`📡 Fetched ${exchangeId} ${symbol}: $${currentPrice}`);
          } catch (fetchError) {
            console.log(`Failed to fetch ${exchangeId} ${symbol}:`, fetchError.message);
            continue;
          }
        } else {
          console.log(`💾 Using cached price for ${exchangeId} ${symbol}: $${currentPrice}`);
        }
        
        const asset = symbol.split('/')[0];
        addToPriceHistory(asset, currentPrice);
        
        for (const strategy of strategies) {
          const parsed = strategy.parsed_strategy;
          if (!parsed || parsed.asset !== asset) continue;
          
          const oldPrice = getPriceFromMinutesAgo(asset, parsed.timeWindow);
          if (!oldPrice) continue;
          
          const dropPercent = ((oldPrice - currentPrice) / oldPrice) * 100;
          
          if (parsed.condition === 'drop' && dropPercent >= parsed.threshold) {
            console.log(`🚨 CRASH DETECTED! ${asset} dropped ${dropPercent.toFixed(2)}% in ${parsed.timeWindow} minutes`);
            const estimatedPositionValue = 1000;
            const savedAmount = estimatedPositionValue * (dropPercent / 100);
            await executeStrategy(strategy.user_id, exchangeId, parsed.action, asset, savedAmount);
          }
        }
      }
      
      for (const strategy of strategies) {
        await supabase
          .from('strategies')
          .update({ last_checked: new Date().toISOString() })
          .eq('id', strategy.id);
      }
      
    } catch (error) {
      console.log(`Error with ${exchangeId}:`, error.message);
    }
  }
}

setInterval(monitorPrices, 120000);
console.log('🚀 Automatic price monitoring started! Checking every 2 minutes');

setTimeout(() => monitorPrices(), 5000);

// ============ API ENDPOINTS ============

app.get('/', (req, res) => {
  res.json({ message: 'CrashGuard Backend Dey Work! 🚀', status: 'online', auto_monitor: 'active' });
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'online', auto_monitor: 'active', cache_ttl: '30 seconds', check_interval: '2 minutes', time: new Date().toISOString() });
});

app.post('/api/connect', async (req, res) => {
  const { exchange, apiKey, secret, userId } = req.body;
  if (!exchange || !apiKey || !secret) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  try {
    const exchangeObj = new ccxt[exchange]({ apiKey, secret, enableRateLimit: true });
    const balance = await exchangeObj.fetchBalance();
    const totalBalance = balance.total;
    let totalBalanceUSD = 0;
    for (const [currency, amount] of Object.entries(totalBalance)) {
      if (amount > 0) {
        try {
          const ticker = await exchangeObj.fetchTicker(`${currency}/USDT`);
          totalBalanceUSD += amount * ticker.last;
        } catch (e) {}
      }
    }
    await supabase.from('connections').upsert({ user_id: userId, exchange, balance: totalBalance, balance_usd: totalBalanceUSD });
    res.json({ success: true, balance: totalBalance, balanceUSD: totalBalanceUSD });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

function parseAiPrompt(prompt) {
  const rules = { asset: null, condition: null, threshold: null, timeWindow: 15, action: null };
  const assetMatch = prompt.match(/\b(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|MATIC)\b/i);
  if (assetMatch) rules.asset = assetMatch[1].toUpperCase();
  if (prompt.match(/drop|falls|decrease|गिरावट|गिरता|नीचे/i)) rules.condition = 'drop';
  else if (prompt.match(/rise|up|increase|बढ़त|उपर|बढ़ता/i)) rules.condition = 'rise';
  const percentMatch = prompt.match(/(\d+)%/i);
  if (percentMatch) rules.threshold = parseInt(percentMatch[1]);
  const timeMatch = prompt.match(/in\s+(\d+)\s+minutes?|(\d+)\s+मिनट/i);
  if (timeMatch) rules.timeWindow = parseInt(timeMatch[1] || timeMatch[2]);
  if (prompt.match(/close all|close everything|close positions|सभी बंद करें|पोजीशन बंद करें/i)) rules.action = 'close_all';
  else if (prompt.match(/stop loss|stoploss|स्टॉप लॉस/i)) rules.action = 'stop_loss';
  else if (prompt.match(/hedge|हेज/i)) rules.action = 'hedge';
  return rules;
}

app.post('/api/strategy/save', async (req, res) => {
  const { userId, aiPrompt, exchange } = req.body;
  if (!userId || !aiPrompt) {
    return res.json({ success: false, error: 'Missing userId or aiPrompt' });
  }
  const parsed = parseAiPrompt(aiPrompt);
  await supabase.from('strategies').upsert({
    user_id: userId,
    strategy: aiPrompt,
    parsed_strategy: parsed,
    exchange: exchange || 'not specified',
    is_active: true,
    last_checked: new Date().toISOString(),
    updated_at: new Date()
  });
  res.json({ success: true, message: 'Strategy saved', parsed });
});

app.post('/api/panic', async (req, res) => {
  const { exchange, apiKey, secret, userId } = req.body;
  if (!exchange || !apiKey || !secret) {
    return res.json({ success: false, error: 'Missing exchange, apiKey, or secret' });
  }
  try {
    const exchangeObj = new ccxt[exchange]({ apiKey, secret });
    const positions = await exchangeObj.fetchPositions();
    let savedAmount = 0;
    for (const position of positions) {
      if (position.contracts > 0) {
        savedAmount += position.contracts * position.entryPrice * 0.05;
      }
    }
    const feeDue = savedAmount * 0.1;
    const netSaved = savedAmount - feeDue;
    await supabase.from('panic_logs').insert({ user_id: userId, exchange, saved_amount: savedAmount, fee_due: feeDue, net_saved: netSaved });
    res.json({ success: true, savedAmount, feeDue, netSaved });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/set-language', async (req, res) => {
  const { userId, language } = req.body;
  if (!userId || !language) return res.json({ success: false, error: 'Missing userId or language' });
  await supabase.from('users').upsert({ user_id: userId, language });
  res.json({ success: true, message: `Language set to ${language}` });
});

app.get('/api/get-language/:userId', async (req, res) => {
  const { userId } = req.params;
  const { data } = await supabase.from('users').select('language').eq('user_id', userId).single();
  if (data && data.language) {
    res.json({ success: true, language: data.language });
  } else {
    res.json({ success: true, language: 'en' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 CrashGuard Backend Running on port ${PORT}`);
  console.log(`🌐 English + Hindi support enabled`);
  console.log(`📊 Price cache TTL: 30 seconds`);
  console.log(`📊 Check interval: 2 minutes`);
  console.log(`📊 Only checking active strategies`);
  console.log(`💳 Payment check endpoint: /api/check-payment/:userId`);
  console.log(`🔑 Supabase key from environment variable`);
});
