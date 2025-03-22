const express = require('express');
const router = express.Router();
const autoTradingService = require('../services/autoTradingService');
const meanReversionService = require('../services/meanReversionService');
const Portfolio = require('../models/Portfolio');
const User = require('../models/userModel');
const Watchlist = require('../models/Watchlist');
const yahooFinance = require('yahoo-finance2').default;

// Start automated trading
router.post('/start/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const user = await User.findOne({ email });
        
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        const success = await autoTradingService.startAutoTrading(email);
        if (success) {
            res.status(200).json({ message: "Automated trading started successfully" });
        } else {
            res.status(400).json({ message: "Automated trading is already active" });
        }
    } catch (error) {
        console.error('Error starting automated trading:', error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Stop automated trading
router.post('/stop/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const success = autoTradingService.stopAutoTrading(email);
        
        if (success) {
            res.status(200).json({ message: "Automated trading stopped successfully" });
        } else {
            res.status(400).json({ message: "Automated trading is not active" });
        }
    } catch (error) {
        console.error('Error stopping automated trading:', error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Get automated trading status
router.get('/status/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const isActive = autoTradingService.isAutoTradingActive(email);
        
        res.status(200).json({ 
            isActive,
            message: isActive ? "Automated trading is active" : "Automated trading is not active"
        });
    } catch (error) {
        console.error('Error getting automated trading status:', error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Get mean reversion signals for portfolio
router.get('/signals/:email', async (req, res) => {
    try {
        console.log('Fetching signals for:', req.params.email);
        const user = await User.findOne({ email: req.params.email });
        if (!user) {
            console.log('User not found:', req.params.email);
            return res.status(404).json({ error: 'User not found' });
        }

        // Clean up invalid stocks first
        await autoTradingService.cleanupInvalidStocks(user._id);

        const portfolio = await Portfolio.findOne({ userId: user._id })
            .populate('stocks.stockId');
        
        if (!portfolio || !portfolio.stocks.length) {
            console.log('No portfolio found or empty portfolio for user:', req.params.email);
            return res.json({ signals: [] });
        }

        console.log(`Found ${portfolio.stocks.length} stocks in portfolio`);

        // Filter out stocks with invalid stockId references
        const validStocks = portfolio.stocks.filter(stock => 
            stock && stock.stockId && stock.stockId.symbol
        );

        console.log(`Found ${validStocks.length} valid stocks in portfolio`);

        // Get portfolio signals
        const portfolioSignals = await meanReversionService.analyzePortfolio(
            validStocks.map(s => ({
                symbol: s.stockId.symbol,
                quantity: s.quantity
            }))
        );

        console.log(`Retrieved ${portfolioSignals.length} portfolio signals`);

        // Get watchlist signals
        let watchlistSignals = [];
        const watchlist = await Watchlist.findOne({ userId: user._id });
        if (watchlist && watchlist.stocks && watchlist.stocks.length > 0) {
            // Filter out invalid watchlist stocks
            const validWatchlistStocks = watchlist.stocks.filter(stock => 
                stock && stock.symbol
            );
            
            if (validWatchlistStocks.length > 0) {
                watchlistSignals = await meanReversionService.analyzeWatchlist(
                    validWatchlistStocks.map(s => s.symbol)
                );
                console.log(`Retrieved ${watchlistSignals.length} watchlist signals`);
            } else {
                console.log('No valid stocks in watchlist');
            }
        } else {
            console.log('No watchlist found for user or empty watchlist');
        }

        // Combine and sort signals by confidence
        const allSignals = [...portfolioSignals, ...watchlistSignals]
            .sort((a, b) => b.confidence - a.confidence);

        console.log(`Total signals before sending: ${allSignals.length}`);
        res.json({ signals: allSignals });
    } catch (error) {
        console.error('Error fetching signals:', error);
        res.status(500).json({ 
            error: 'Error fetching signals',
            details: error.message,
            stack: error.stack
        });
    }
});

// Test endpoint to check signals for a specific stock
router.get('/test/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const signal = await meanReversionService.calculateMeanReversionSignal(symbol);
        
        if (!signal) {
            return res.status(404).json({ message: "Could not calculate signal for this stock" });
        }

        res.status(200).json({
            message: "Signal calculated successfully",
            signal: {
                ...signal,
                details: {
                    lookbackPeriod: meanReversionService.lookbackPeriod,
                    standardDeviations: meanReversionService.standardDeviations,
                    interpretation: signal.zScore > meanReversionService.standardDeviations 
                        ? "Stock is significantly overvalued" 
                        : signal.zScore < -meanReversionService.standardDeviations 
                            ? "Stock is significantly undervalued"
                            : "Stock is trading near its mean"
                }
            }
        });
    } catch (error) {
        console.error('Error testing mean reversion signal:', error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Test Yahoo Finance API
router.get('/test-yahoo/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        console.log('Testing Yahoo Finance API for symbol:', symbol);
        
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 20);

        // Format dates for Yahoo Finance API (convert to Unix timestamp)
        const formattedStartDate = Math.floor(startDate.getTime() / 1000);
        const formattedEndDate = Math.floor(endDate.getTime() / 1000);

        const chartData = await yahooFinance.chart(symbol, {
            period1: formattedStartDate,
            period2: formattedEndDate,
            interval: '1d'
        });

        if (!chartData || !chartData.result || !chartData.result[0] || !chartData.result[0].indicators || !chartData.result[0].indicators.quote) {
            console.log(`No data available for ${symbol}`);
            return res.status(404).json({ 
                message: "No data available for this symbol",
                symbol 
            });
        }

        const quotes = chartData.result[0].indicators.quote;
        const timestamps = chartData.result[0].timestamp;

        console.log('Received data points:', quotes.close.length);
        res.status(200).json({
            message: "Yahoo Finance API test successful",
            dataPoints: quotes.close.length,
            lastPrice: quotes.close[quotes.close.length - 1]
        });
    } catch (error) {
        console.error('Error testing Yahoo Finance API:', error);
        res.status(500).json({ 
            message: "Error testing Yahoo Finance API",
            error: error.message 
        });
    }
});

module.exports = router; 