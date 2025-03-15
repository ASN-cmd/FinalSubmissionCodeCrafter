const express = require('express');
const router = express.Router();
const Stock = require('../models/Stock');
const Portfolio = require('../models/Portfolio');
const Transaction = require('../models/Transaction');
const User = require('../models/userModel');
const { getStockQuote, updateStockPrices } = require('../utils/yahooFinance');
const yahooFinance = require('yahoo-finance2').default;

/**
 * @route   GET /api/stocks
 * @desc    Get all available stocks with real-time data
 */
router.get('/', async (req, res) => {
    try {
        const stocks = await Stock.find({});
        if (!stocks || stocks.length === 0) {
            return res.status(404).json({ message: "No stocks found in database" });
        }

        try {
            const updatedStocks = await updateStockPrices(stocks);
            
            // Update stocks in database with new prices
            const updatePromises = updatedStocks.map(async (stockData) => {
                const stock = stocks.find(s => s.symbol === stockData.symbol);
                if (!stock) return null;

                await Stock.findOneAndUpdate(
                    { symbol: stockData.symbol },
                    {
                        price: stockData.price,
                        change: stockData.change,
                        changePercent: stockData.changePercent,
                        volume: stockData.volume,
                        marketCap: stockData.marketCap,
                        lastUpdated: new Date()
                    }
                );
                return {
                    ...stockData,
                    quantity: stock.quantity,
                    _id: stock._id
                };
            });

            const finalStocks = (await Promise.all(updatePromises)).filter(stock => stock !== null);
            if (finalStocks.length === 0) {
                return res.status(500).json({ message: "Failed to update stock prices" });
            }
            res.status(200).json(finalStocks);
        } catch (yahooError) {
            console.error('Yahoo Finance API Error:', yahooError);
            // If Yahoo Finance fails, return the existing stock data
            res.status(200).json(stocks.map(stock => ({
                ...stock.toObject(),
                change: 0,
                changePercent: 0
            })));
        }
    } catch (error) {
        console.error('Database Error:', error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

/**
 * @route   GET /api/stocks/portfolio/:email
 * @desc    Get user's stock portfolio with real-time data
 */
router.get('/portfolio/:email', async (req, res) => {
    try {
        const { email } = req.params;
        console.log(`Fetching portfolio for email: ${email}`);

        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }
        
        // Find user
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            console.log(`User not found for email: ${email}`);
            return res.status(404).json({ 
                message: "User not found",
                details: "Please make sure you are logged in with the correct account"
            });
        }
        console.log(`Found user with ID: ${user._id}`);

        // Find portfolio
        const portfolio = await Portfolio.findOne({ userId: user._id })
            .populate({
                path: 'stocks.stockId',
                model: 'Stock',
                select: 'symbol name price'
            });
        
        console.log(`Portfolio found: ${portfolio ? 'Yes' : 'No'}`);
        
        if (!portfolio) {
            // Create an empty portfolio for the user
            const newPortfolio = new Portfolio({ userId: user._id, stocks: [] });
            await newPortfolio.save();
            return res.status(200).json([]);
        }
        
        if (!portfolio.stocks || portfolio.stocks.length === 0) {
            return res.status(200).json([]);
        }
        
        console.log(`Number of stocks in portfolio: ${portfolio.stocks.length}`);

        try {
            // Get stock symbols and validate them
            const stockSymbols = portfolio.stocks
                .filter(s => s.stockId && s.stockId.symbol)
                .map(s => s.stockId.symbol);

            if (stockSymbols.length === 0) {
                console.log('No valid stock symbols found in portfolio');
                return res.status(200).json([]);
            }

            console.log(`Fetching real-time data for symbols: ${stockSymbols.join(', ')}`);

            // Fetch real-time data
            const realTimeData = await Promise.all(
                stockSymbols.map(symbol => 
                    getStockQuote(symbol).catch(err => {
                        console.error(`Error fetching quote for ${symbol}:`, err);
                        return null;
                    })
                )
            );

            const validRealTimeData = realTimeData.filter(data => data !== null);
            console.log(`Successfully fetched real-time data for ${validRealTimeData.length} stocks`);

            // Format portfolio data
            const formattedPortfolio = portfolio.stocks
                .filter(s => s.stockId && s.stockId.symbol)
                .map(s => {
                    const realTimeStock = validRealTimeData.find(rt => rt.symbol === s.stockId.symbol);
                    if (!realTimeStock) {
                        console.log(`No real-time data found for ${s.stockId.symbol}, using stored data`);
                        return {
                            symbol: s.stockId.symbol,
                            name: s.stockId.name,
                            quantity: s.quantity,
                            currentPrice: s.stockId.price,
                            change: 0,
                            changePercent: 0
                        };
                    }
                    return {
                        symbol: s.stockId.symbol,
                        name: s.stockId.name,
                        quantity: s.quantity,
                        currentPrice: realTimeStock.price,
                        change: realTimeStock.change,
                        changePercent: realTimeStock.changePercent
                    };
                });

            console.log(`Successfully formatted portfolio data for ${formattedPortfolio.length} stocks`);
            res.status(200).json(formattedPortfolio);
        } catch (yahooError) {
            console.error('Yahoo Finance API Error:', yahooError);
            console.log('Falling back to stored data due to Yahoo Finance API error');
            
            // If Yahoo Finance fails, return portfolio with stored prices
            const formattedPortfolio = portfolio.stocks
                .filter(s => s.stockId && s.stockId.symbol)
                .map(s => ({
            symbol: s.stockId.symbol,
            name: s.stockId.name,
            quantity: s.quantity,
                    currentPrice: s.stockId.price,
                    change: 0,
                    changePercent: 0
        }));
        res.status(200).json(formattedPortfolio);
        }
    } catch (error) {
        console.error('Portfolio Route Error:', {
            message: error.message,
            stack: error.stack,
            email: req.params.email
        });
        res.status(500).json({ 
            message: "Failed to load portfolio data",
            error: error.message,
            details: "Please try again later or contact support if the problem persists"
        });
    }
});

/**
 * @route   GET /api/stocks/user-stats/:email
 * @desc    Get user statistics (stocks purchased, sold, credits)
 */
router.get('/user-stats/:email', async (req, res) => {
    try {
        const { email } = req.params;
        console.log(`Fetching user statistics for email: ${email}`);

        if (!email) {
            return res.status(400).json({ 
                message: "Email is required",
                details: "Please provide a valid email address"
            });
        }

        // Initialize default statistics
        const defaultStats = {
            totalPurchased: 0,
            totalSold: 0,
            currentHoldings: 0,
            totalSpent: 0,
            totalEarned: 0,
            currentCredits: 0, // Changed from 10000 to 0
            portfolioValue: 0,
            netWorth: 0 // Changed from 10000 to 0
        };
        
        // Find user
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            console.log(`User not found for email: ${email}`);
            return res.status(404).json({ 
                message: "User not found",
                details: "Please make sure you are logged in with the correct account"
            });
        }
        console.log(`Found user with ID: ${user._id}`);
        
        try {
            // Get all transactions for the user
            const transactions = await Transaction.find({ 
                userEmail: email.toLowerCase(),
                price: { $exists: true, $ne: null },
                quantity: { $exists: true, $ne: null }
            });
            console.log(`Found ${transactions.length} valid transactions for user`);
            
            if (!transactions || transactions.length === 0) {
                console.log('No transactions found, returning default stats with user credits');
                return res.status(200).json({
                    ...defaultStats,
                    currentCredits: user.credits,
                    netWorth: user.credits
                });
            }

            // Calculate statistics with validation
            const buyTransactions = transactions.filter(t => t.type === 'BUY' && t.price > 0 && t.quantity > 0);
            const sellTransactions = transactions.filter(t => t.type === 'SELL' && t.price > 0 && t.quantity > 0);
            
            const totalPurchased = buyTransactions.reduce((total, t) => total + (Number(t.quantity) || 0), 0);
            const totalSold = sellTransactions.reduce((total, t) => total + (Number(t.quantity) || 0), 0);
            
            // Calculate total spent and earned with validation
            const totalSpent = buyTransactions.reduce((total, t) => {
                const price = Number(t.price) || 0;
                const quantity = Number(t.quantity) || 0;
                return total + (price * quantity);
            }, 0);

            const totalEarned = sellTransactions.reduce((total, t) => {
                const price = Number(t.price) || 0;
                const quantity = Number(t.quantity) || 0;
                return total + (price * quantity);
            }, 0);
            
            // Use user's actual credits instead of starting credits
            const currentCredits = user.credits;
            
            let portfolioValue = 0;
            try {
        // Get current portfolio value
                const portfolio = await Portfolio.findOne({ userId: user._id })
                    .populate({
                        path: 'stocks.stockId',
                        model: 'Stock',
                        select: 'symbol name price'
                    });

                if (portfolio?.stocks?.length > 0) {
                    // Get real-time prices for portfolio stocks
                    const stockSymbols = portfolio.stocks
                        .filter(s => s.stockId?.symbol)
                        .map(s => s.stockId.symbol);

                    if (stockSymbols.length > 0) {
                        const realTimeData = await Promise.all(
                            stockSymbols.map(symbol => 
                                getStockQuote(symbol).catch(err => {
                                    console.error(`Error fetching quote for ${symbol}:`, err);
                                    return null;
                                })
                            )
                        );

                        // Calculate portfolio value using real-time prices when available
            portfolioValue = portfolio.stocks.reduce((total, stock) => {
                            if (!stock.stockId?.symbol || !stock.quantity) return total;
                            
                            const realTimeStock = realTimeData.find(rt => rt?.symbol === stock.stockId.symbol);
                            const price = realTimeStock?.price || stock.stockId.price || 0;
                            const quantity = Number(stock.quantity) || 0;
                            
                            return total + (price * quantity);
            }, 0);
                    }
                }
            } catch (portfolioError) {
                console.error('Portfolio calculation error:', portfolioError);
                // Continue with portfolioValue as 0
        }
        
            const stats = {
            totalPurchased,
            totalSold,
                currentHoldings: Math.max(0, totalPurchased - totalSold),
            totalSpent,
            totalEarned,
                currentCredits: Math.max(0, currentCredits),
                portfolioValue: Math.max(0, portfolioValue),
                netWorth: Math.max(0, currentCredits + portfolioValue)
            };

            console.log('Successfully calculated user statistics:', stats);
            res.status(200).json(stats);
        } catch (dataError) {
            console.error('Error calculating statistics:', dataError);
            // Return default stats if calculation fails
            res.status(200).json(defaultStats);
        }
    } catch (error) {
        console.error('User Stats Route Error:', {
            message: error.message,
            stack: error.stack,
            email: req.params.email
        });
        res.status(500).json({ 
            message: "Failed to load user statistics",
            error: error.message,
            details: "Please try again later or contact support if the problem persists"
        });
    }
});

/**
 * @route   POST /api/stocks/buy
 * @desc    Buy stocks and update market + user portfolio with real-time price
 */
router.post('/buy', async (req, res) => {
    try {
        const { email, symbol, quantity } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: "User not found" });
        
        const stock = await Stock.findOne({ symbol: symbol.toUpperCase() });
        if (!stock) return res.status(404).json({ message: "Stock not found" });
        
        if (stock.quantity < quantity) {
            return res.status(400).json({ message: "Not enough stock available" });
        }

        // Get real-time price
        const realTimeQuote = await getStockQuote(symbol);
        
        // Calculate total cost
        const totalCost = realTimeQuote.price * quantity;

        // Check if user has enough credits
        if (user.credits < totalCost) {
            return res.status(400).json({ 
                message: "Insufficient credits", 
                required: totalCost,
                available: user.credits
            });
        }

        // Update user credits
        user.credits -= totalCost;
        await user.save();
        
        stock.quantity -= quantity;
        stock.price = realTimeQuote.price;
        stock.change = realTimeQuote.change;
        stock.changePercent = realTimeQuote.changePercent;
        stock.volume = realTimeQuote.volume;
        stock.marketCap = realTimeQuote.marketCap;
        stock.lastUpdated = new Date();
        await stock.save();
        
        const transaction = new Transaction({
            userEmail: email,
            symbol: stock.symbol,
            name: stock.name,
            price: realTimeQuote.price,
            quantity,
            type: "BUY"
        });
        await transaction.save();
        
        let portfolio = await Portfolio.findOne({ userId: user._id });
        if (!portfolio) {
            portfolio = new Portfolio({ userId: user._id, stocks: [] });
        }
        
        const stockIndex = portfolio.stocks.findIndex(s => s.stockId.equals(stock._id));
        if (stockIndex >= 0) {
            portfolio.stocks[stockIndex].quantity += quantity;
        } else {
            portfolio.stocks.push({ stockId: stock._id, quantity });
        }
        await portfolio.save();

        res.status(200).json({ 
            message: "Stock purchased successfully", 
            transaction, 
            portfolio,
            currentPrice: realTimeQuote.price,
            remainingCredits: user.credits
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

/**
 * @route   POST /api/stocks/sell
 * @desc    Sell stocks and update user portfolio + market
 */
router.post('/sell', async (req, res) => {
    try {
        const { email, symbol, quantity } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: "User not found" });
        
        const stock = await Stock.findOne({ symbol: symbol.toUpperCase() });
        if (!stock) return res.status(404).json({ message: "Stock not found" });
        
        let portfolio = await Portfolio.findOne({ userId: user._id });
        if (!portfolio) return res.status(400).json({ message: "No holdings found" });
        
        const stockIndex = portfolio.stocks.findIndex(s => s.stockId.equals(stock._id));
        if (stockIndex < 0 || portfolio.stocks[stockIndex].quantity < quantity) {
            return res.status(400).json({ message: "Not enough stocks to sell" });
        }

        // Get real-time price for selling
        const realTimeQuote = await getStockQuote(symbol);
        const totalEarnings = realTimeQuote.price * quantity;

        // Update user credits with earnings
        user.credits += totalEarnings;
        await user.save();
        
        portfolio.stocks[stockIndex].quantity -= quantity;
        if (portfolio.stocks[stockIndex].quantity === 0) {
            portfolio.stocks.splice(stockIndex, 1);
        }
        await portfolio.save();
        
        stock.quantity += quantity;
        stock.price = realTimeQuote.price;
        stock.change = realTimeQuote.change;
        stock.changePercent = realTimeQuote.changePercent;
        stock.volume = realTimeQuote.volume;
        stock.marketCap = realTimeQuote.marketCap;
        stock.lastUpdated = new Date();
        await stock.save();
        
        const transaction = new Transaction({
            userEmail: email,
            symbol: stock.symbol,
            name: stock.name,
            price: realTimeQuote.price,
            quantity,
            type: "SELL"
        });
        await transaction.save();

        res.status(200).json({ 
            message: "Stock sold successfully", 
            transaction, 
            portfolio,
            currentPrice: realTimeQuote.price,
            earnedCredits: totalEarnings,
            newCreditBalance: user.credits
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

/**
 * @route   GET /api/stocks/intraday/:symbol
 * @desc    Get intraday data for a specific stock
 */
router.get('/intraday/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        console.log(`Intraday request for symbol: ${symbol}`);
        
        // Get stock details
        const stock = await Stock.findOne({ symbol: symbol.toUpperCase() });
        if (!stock) {
            console.log(`Stock not found: ${symbol}`);
            return res.status(404).json({ message: "Stock not found" });
        }

        try {
            // Get intraday data from Yahoo Finance
            console.log(`Fetching quote for ${symbol}`);
            const quote = await yahooFinance.quote(symbol);
            
            console.log(`Fetching chart data for ${symbol}`);
            const intradayData = await yahooFinance.chart(symbol, {
                interval: '15m',
                range: '1d'
            });

            // Generate sample chart data if no data is available
            let chartData = [];
            if (intradayData.quotes && intradayData.quotes.length > 0) {
                console.log(`Received ${intradayData.quotes.length} data points for ${symbol}`);
                chartData = intradayData.quotes.map(quote => ({
                    time: new Date(quote.timestamp * 1000).toLocaleTimeString(),
                    price: quote.close || quote.open,
                    volume: quote.volume
                }));
            } else {
                console.log(`No chart data available for ${symbol}, generating sample data`);
                // Generate sample data
                const basePrice = quote.regularMarketPrice || stock.price || 100;
                const now = new Date();
                
                for (let i = 0; i < 24; i++) {
                    const time = new Date(now.getTime() - (23 - i) * 3600000);
                    chartData.push({
                        time: time.toLocaleTimeString(),
                        price: basePrice + (Math.random() * 10 - 5),
                        volume: Math.floor(Math.random() * 1000000)
                    });
                }
            }

            // Format the response
            const stockDetails = {
                symbol: stock.symbol,
                name: stock.name,
                currentPrice: quote.regularMarketPrice || stock.price,
                change: quote.regularMarketChange || 0,
                changePercent: quote.regularMarketChangePercent || 0,
                open: quote.regularMarketOpen || stock.price,
                high: quote.regularMarketDayHigh || stock.price,
                low: quote.regularMarketDayLow || stock.price,
                volume: quote.regularMarketVolume || 0,
                marketCap: quote.marketCap || 0,
                chartData: chartData
            };

            console.log(`Successfully prepared stock details for ${symbol}`);
            res.status(200).json(stockDetails);
        } catch (yahooError) {
            console.error('Yahoo Finance API Error:', yahooError);
            
            // Generate sample chart data
            console.log(`Generating sample data for ${symbol} due to Yahoo Finance API error`);
            const basePrice = stock.price || 100;
            const now = new Date();
            const chartData = [];
            
            for (let i = 0; i < 24; i++) {
                const time = new Date(now.getTime() - (23 - i) * 3600000);
                chartData.push({
                    time: time.toLocaleTimeString(),
                    price: basePrice + (Math.random() * 10 - 5),
                    volume: Math.floor(Math.random() * 1000000)
                });
            }
            
            // If real-time data fails, return basic stock info with sample chart data
            res.status(200).json({
                symbol: stock.symbol,
                name: stock.name,
                currentPrice: stock.price,
                change: 0,
                changePercent: 0,
                open: stock.price,
                high: stock.price * 1.02, // Sample high price (2% above current)
                low: stock.price * 0.98,  // Sample low price (2% below current)
                volume: Math.floor(Math.random() * 10000000),
                marketCap: stock.price * 1000000000,
                chartData: chartData
            });
        }
    } catch (error) {
        console.error('Stock Details Error:', error);
        res.status(500).json({ 
            message: "Failed to fetch stock details",
            error: error.messages
        });
    }
});

module.exports = router;
