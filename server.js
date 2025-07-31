import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fetch from 'node-fetch';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import TelegramBot from 'node-telegram-bot-api';

// Replace these with your actual Telegram bot token and group chat ID
const TELEGRAM_BOT_TOKEN = '7670597940:AAFa701w9UEKrp5TMO2fhJJdPIQvNlbgt4o';
const TELEGRAM_GROUP_ID = '-1002448457816';

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const http = createServer(app);
const io = new Server(http);

// Add this near the top of your file where you set up socket.io
const originalConsoleLog = console.log;
console.log = function() {
    // Call the original console.log
    originalConsoleLog.apply(console, arguments);
    
    // Convert arguments to string and emit to connected clients
    const message = Array.from(arguments).join(' ');
    io.emit('terminalLog', { message });
};

// Optional: Also capture console.error
const originalConsoleError = console.error;
console.error = function() {
    // Call the original console.error
    originalConsoleError.apply(console, arguments);
    
    // Convert arguments to string and emit to connected clients
    const message = Array.from(arguments).join(' ');
    io.emit('terminalLog', { message: `[ERROR] ${message}` });
};

// Scanner code
class SymbolScanner extends EventEmitter {
    constructor() {
        super();
        this.priceHistory = new Map();
        this.volatilityScores = new Map();
        this.volumes = new Map();
        this.fundingRates = new Map();
        this.performerCounts = new Map();
        this.allTimePerformers = new Set(); // Track all symbols that were ever best performers
        this.lastBestPerformer = null;
        this.lastMinuteCheck = null;
        this.isRunning = false;
        this.intervalId = null;
        this.hasErrorThisMinute = false;
        this.lastScannerResult = null;
        // Remove MAX_COUNT as we're going infinite
        // Add new properties for scoring system
        this.volumeHistory = new Map(); // Store last 2 minutes of volume
        this.scoreHistory = new Map();  // Store scoring history
        this.potentialCandidates = new Map(); // Store current candidates
        // Add new properties for Bollinger Bands
        this.bollingerPeriod = 20; // Standard period for Bollinger Bands
        this.bollingerStdDev = 2;  // Standard deviation multiplier
        // Add new properties for history tracking
        this.candidateHistory = new Map(); // Store candidate history
        this.lastDayReset = null; // Track when we last reset daily counts
        this.sentTelegramToday = new Set(); // Track symbols that already triggered Telegram today
    }

    reset() {
        this.priceHistory.clear();
        this.volatilityScores.clear();
        this.volumes.clear();
        this.fundingRates.clear();
        // Don't reset performerCounts
        this.hasErrorThisMinute = false;
    }

    resetDailyCounts() {
        const now = new Date();
        // Convert to Central European Time
        const cetTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
        const cetDay = cetTime.getDate();

        if (this.lastDayReset !== cetDay) {
            //console.log('Resetting for new CET day - Clearing all data structures');
            
            // Clear all price and market data
            this.priceHistory.clear();
            this.volatilityScores.clear();
            this.volumes.clear();
            this.fundingRates.clear();
            this.volumeHistory.clear();
            this.scoreHistory.clear();
            
            // Clear candidate tracking
            this.candidateHistory.clear();
            this.potentialCandidates.clear();
            
            // Clear performance tracking
            this.allTimePerformers.clear();
            this.performerCounts.clear();
            
            // Reset error flags and results
            this.hasErrorThisMinute = false;
            this.lastScannerResult = null;
            this.lastBestPerformer = null;
            
            // Emit empty state to clear the webpage
            this.emit('bestPerformerFound', { 
                potentialCandidates: []
            });
            
            // Update last reset time
            this.lastDayReset = cetDay;
            this.sentTelegramToday.clear(); // Clear the sent notifications tracking
            
            //console.log('Daily reset completed - All data structures cleared');
        }
    }

    updateCandidateHistory(symbol, timestamp) {
        const now = new Date();
        
        if (!this.candidateHistory.has(symbol)) {
            this.candidateHistory.set(symbol, {
                occurrences: [],
                dailyCount: 0,
                firstSeen: now.toISOString(),
                lastSeen: now.toISOString()
            });
        }

        const history = this.candidateHistory.get(symbol);
        history.occurrences.push(now.toISOString());
        history.lastSeen = now.toISOString();  // Update lastSeen
        history.dailyCount++;
    }

    // Add this method to clean up old price history
    cleanupPriceHistory() {
        const now = new Date();
        const twoMinutesAgo = new Date(now - 120000); // 2 minutes ago
        
        this.priceHistory.forEach((prices, symbol) => {
            this.priceHistory.set(symbol, 
                prices.filter(p => p.timestamp >= twoMinutesAgo)
            );
        });
    }

    cleanupVolumeHistory() {
        const now = new Date();
        const twoMinutesAgo = new Date(now - 120000);
        
        this.volumeHistory.forEach((volumes, symbol) => {
            this.volumeHistory.set(symbol, 
                volumes.filter(v => v.timestamp >= twoMinutesAgo)
            );
        });
    }

    async fetchTickers() {
        try {
            await this.cleanupPriceHistory();
            await this.cleanupVolumeHistory(); // Add cleanup call
            const response = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
            const data = await response.json();
            const currentTime = new Date();
            
            data.result.list.forEach(ticker => {
                if (ticker.symbol.endsWith('USDT')) {
                    const price = parseFloat(ticker.lastPrice);
                    const volume = parseFloat(ticker.turnover24h);
                    const fundingRate = parseFloat(ticker.fundingRate);
                    
                    // Store previous volume for comparison
                    if (!this.volumeHistory.has(ticker.symbol)) {
                        this.volumeHistory.set(ticker.symbol, []);
                    }
                    const volumeData = this.volumeHistory.get(ticker.symbol);
                    volumeData.push({ volume, timestamp: currentTime });
                    // Keep only last 2 minutes of volume data
                    while (volumeData.length > 0 && 
                           volumeData[0].timestamp < new Date(currentTime - 120000)) {
                        volumeData.shift();
                    }
                    
                    // Existing price history logic...
                    if (!this.priceHistory.has(ticker.symbol)) {
                        this.priceHistory.set(ticker.symbol, []);
                    }
                    this.priceHistory.get(ticker.symbol).push({
                        price,
                        timestamp: currentTime
                    });

                    this.volumes.set(ticker.symbol, volume);
                    this.fundingRates.set(ticker.symbol, fundingRate);
                }
            });

            // Calculate scores after updating data
            this.calculateCandidateScores();
        } catch (error) {
            console.error('Error fetching tickers:', error);
            this.hasErrorThisMinute = true;
        }
    }

    calculateVolatility() {
        this.volatilityScores.clear();
        const now = new Date();
        const oneMinuteAgo = new Date(now - 60000);

        for (const [symbol, prices] of this.priceHistory.entries()) {
            const relevantPrices = prices.filter(p => p.timestamp >= oneMinuteAgo);
            
            if (relevantPrices.length < 2) continue;

            let totalMovement = 0;
            for (let i = 1; i < relevantPrices.length; i++) {
                const movement = Math.abs(
                    relevantPrices[i].price - relevantPrices[i-1].price
                );
                totalMovement += movement;
            }

            const averagePrice = relevantPrices.reduce((sum, p) => sum + p.price, 0) / relevantPrices.length;
            const volatilityScore = (totalMovement / averagePrice) * 100;
            
            this.volatilityScores.set(symbol, volatilityScore);
        }
    }

    updatePerformerCounts(newBestPerformer) {
        // Add to all-time performers set
        this.allTimePerformers.add(newBestPerformer);

        // Increment new best performer (no max limit)
        const currentCount = this.performerCounts.get(newBestPerformer) || 0;
        this.performerCounts.set(newBestPerformer, currentCount + 1);

        // Decrement all other symbols (can go negative)
        for (const symbol of this.allTimePerformers) {
            if (symbol !== newBestPerformer) {
                const count = this.performerCounts.get(symbol) || 0;
                this.performerCounts.set(symbol, count - 1);
            }
        }

        // Get all symbols sorted by count
        const sortedPerformers = Array.from(this.allTimePerformers)
            .map(symbol => ({
                symbol,
                count: this.performerCounts.get(symbol) || 0,
                lastPrice: this.priceHistory.get(symbol)?.slice(-1)[0]?.price || 0
            }))
            .filter(item => item.lastPrice > 0)
            .sort((a, b) => b.count - a.count)
            .map(item => ({
                symbol: item.symbol,
                count: item.count,
                lowerPrice: (item.lastPrice * 0.15).toFixed(4),
                higherPrice: (item.lastPrice * 5).toFixed(4)
            }));

        return sortedPerformers;
    }

    calculateCandidateScores() {
        const minVolume = 10000000; // $10M minimum volume
        this.potentialCandidates.clear();
        let debugCount = 0;
        let failedVolume = 0;
        let failedScore = 0;

        for (const [symbol, priceData] of this.priceHistory.entries()) {
            debugCount++;
            const volume = this.volumes.get(symbol) || 0;
            
            // Log volume check
            if (volume < minVolume) {
                failedVolume++;
                //console.log(`${symbol} failed volume check: $${(volume/1000000).toFixed(2)}M < $${minVolume/1000000}M`);
                continue;
            }

            const currentPrice = priceData[priceData.length - 1]?.price;
            const prevPrice = priceData[priceData.length - 2]?.price;
            
            if (!currentPrice || !prevPrice) continue;

            const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;
            const volumeHistory = this.volumeHistory.get(symbol) || [];
            const currentVolume = volumeHistory[volumeHistory.length - 1] || 0;
            const prevVolume = volumeHistory[volumeHistory.length - 2] || 0;
            
            const volumeIncrease = prevVolume ? ((currentVolume - prevVolume) / prevVolume) * 100 : 0;
            const fundingRate = this.fundingRates.get(symbol) || 0;

            // Calculate and log detailed scores
            const volumeScore = Math.min(Math.max(volumeIncrease, 0), 100) * 0.5;
            const fundingScore = Math.min(Math.abs(fundingRate) * 1000, 100) * 0.2;
            const volatilityScore = (this.volatilityScores.get(symbol) || 0) * 0.3;
            const totalScore = volumeScore + fundingScore + volatilityScore;

            // Log all symbols with decent scores
            if (totalScore > 5) {
                console.log(`${symbol} scores:`, {
                    total: totalScore.toFixed(2),
                    volume: volumeScore.toFixed(2),
                    funding: fundingScore.toFixed(2),
                    volatility: volatilityScore.toFixed(2),
                    priceChange: priceChange.toFixed(2) + '%',
                    volumeChange: volumeIncrease.toFixed(2) + '%',
                    fundingRate: (fundingRate * 100).toFixed(4) + '%'
                });
            }

            if (totalScore <= 15) {
                failedScore++;
                continue;
            }

            this.potentialCandidates.set(symbol, {
                symbol,
                score: totalScore.toFixed(2),
                volumeIncrease: volumeIncrease.toFixed(2),
                fundingRate: (fundingRate * 100).toFixed(4),
                volatility: this.volatilityScores.get(symbol)?.toFixed(2) || '0',
                price: currentPrice,
                priceChange: priceChange.toFixed(2)
            });
        }

        // Summary log
        //console.log(`Candidate Scan Summary:`, {
        //    totalSymbols: debugCount,
        //    failedVolumeCheck: failedVolume,
        //    failedScoreCheck: failedScore,
        //    passedAll: this.potentialCandidates.size,
        //    volumeThreshold: `$${minVolume/1000000}M`,
        //    scoreThreshold: 15
        //});
    }

    async findBestPerformer() {
        const minVolume = 10000000; // $10M minimum 24h volume
        const topPairs = Array.from(this.volatilityScores.entries())
            .filter(([symbol]) => this.volumes.get(symbol) >= minVolume)
            .sort(([symbolA, scoreA], [symbolB, scoreB]) => {
                const scoreDiff = scoreB - scoreA;
                if (Math.abs(scoreDiff) > 0.0001) {
                    return scoreDiff;
                }
                return this.volumes.get(symbolB) - this.volumes.get(symbolA);
            });

        if (!topPairs.length) {
            return {
                symbol: null,
                moves: 0,
                volume24h: 0,
                fundingRate: 0,
                lastPrice: 0,
                hasError: this.hasErrorThisMinute
            };
        }

        const [symbol, score] = topPairs[0];
        const volume24h = this.volumes.get(symbol) / 1000000; // Convert to millions
        const fundingRate = this.fundingRates.get(symbol) * 100; // Convert to percentage
        const lastPrice = this.priceHistory.get(symbol).slice(-1)[0].price; // Get the last price

        // Add debug logging
        //console.log(`Best performer found: ${symbol}`, {
        //    volatilityScore: score.toFixed(2),
        //    volume: `$${volume24h.toFixed(2)}M`,
        //    fundingRate: `${fundingRate.toFixed(4)}%`,
        //    price: lastPrice
        //});

        const result = {
            symbol,
            moves: Math.round(score * 100),
            volume24h: volume24h.toFixed(2),
            fundingRate: fundingRate.toFixed(4),
            lastPrice: lastPrice,
            hasError: this.hasErrorThisMinute
        };

        this.lastScannerResult = result;
        return result;
    }

    // New method to fetch historical candles
    async fetchHistoricalCandles(symbol) {
        try {
            const response = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=1000`);
            const data = await response.json();
            
            if (!data.result?.list || data.result.list.length === 0) {
                console.log(`No historical data for ${symbol}`);
                return null;
            }

            return data.result.list.map(candle => ({
                timestamp: parseInt(candle[0]),
                open: parseFloat(candle[1]),
                high: parseFloat(candle[2]),
                low: parseFloat(candle[3]),
                close: parseFloat(candle[4]),
                volume: parseFloat(candle[5]),
                turnover: parseFloat(candle[6])
            }));

        } catch (error) {
            console.error(`Error fetching historical data for ${symbol}:`, error);
            return null;
        }
    }

    // Calculate Bollinger Bands
    calculateBollingerBands(prices) {
        if (prices.length < this.bollingerPeriod) {
            return null;
        }

        // Reverse the array to get oldest first, then take last bollingerPeriod candles
        const recentPrices = [...prices]
            .reverse()
            .slice(-this.bollingerPeriod)
            .map(p => p.close);

        // Calculate SMA
        const sma = recentPrices.reduce((a, b) => a + b) / this.bollingerPeriod;

        // Calculate Standard Deviation
        const squareDiffs = recentPrices.map(price => Math.pow(price - sma, 2));
        const standardDeviation = Math.sqrt(squareDiffs.reduce((a, b) => a + b) / this.bollingerPeriod);

        // Calculate Bands
        const upperBand = sma + (standardDeviation * this.bollingerStdDev);
        const lowerBand = sma - (standardDeviation * this.bollingerStdDev);
        const middleBand = sma;

        return {
            upper: upperBand,
            middle: middleBand,
            lower: lowerBand
        };
    }

    
 // Check if trade meets criteria
async checkTradeCriteria(currentPrice, bollingerBands, openPrice, symbol) {
    if (!bollingerBands) return false;

    // Get price history
    const priceHistory = this.priceHistory.get(symbol) || [];
    if (priceHistory.length < 2) return false; // Need at least current and previous candle

    const currentCandle = priceHistory[priceHistory.length - 1];
    const previousCandle = priceHistory[priceHistory.length - 2];

    // Skip signal if previous candle was already above upper Bollinger Band (body or wick)
    if (previousCandle.high >= bollingerBands.upper) {
        return false;
    }

    // Check if current price is crossing over the upper Bollinger Band
    if (currentPrice >= bollingerBands.upper && previousCandle.price < bollingerBands.upper) {

        // Get historical candles for detailed analysis
        const historicalCandles = await this.fetchHistoricalCandles(symbol);
        if (!historicalCandles || historicalCandles.length < 3) {
            return true; // If we can't get historical data, use basic criteria
        }

        // Find the most recent candle that interacted with lower Bollinger Band
        let lowerBandCandleIndex = -1;
        for (let i = 0; i < historicalCandles.length; i++) {
            const candle = historicalCandles[i];

            // Calculate Bollinger Bands for this point in time
            const candlesForBB = historicalCandles.slice(i);
            const bbForCandle = this.calculateBollingerBands(candlesForBB);

            if (bbForCandle && (
                candle.high >= bbForCandle.lower ||
                candle.low <= bbForCandle.lower ||
                candle.open >= bbForCandle.lower ||
                candle.close >= bbForCandle.lower
            )) {
                lowerBandCandleIndex = i;
                break; // Found the most recent one
            }
        }

        // If no lower band interaction found, use basic criteria
        if (lowerBandCandleIndex === -1) {
            return true;
        }

        // Check all candles between lower band candle and current candle
        for (let i = lowerBandCandleIndex + 1; i < historicalCandles.length; i++) {
            const candle = historicalCandles[i];

            // Calculate Bollinger Bands for this point in time
            const candlesForBB = historicalCandles.slice(i);
            const bbForCandle = this.calculateBollingerBands(candlesForBB);

            if (bbForCandle && (
                candle.high >= bbForCandle.upper ||
                candle.low >= bbForCandle.upper ||
                candle.open >= bbForCandle.upper ||
                candle.close >= bbForCandle.upper
            )) {
                // Found a candle that touched upper band between lower band crossing and now
                return false;
            }
        }

        return true;
    }

    return false;
}

    // New criteria
    checkTradeCriteria2(currentPrice, bollingerBands, openPrice, symbol) {
        if (!bollingerBands) return false;
        
        const currentCandle = this.priceHistory.get(symbol)?.slice(-1)[0];
        if (!currentCandle) return false;
        
        // Check if candle's high (wick) touches or crosses upper band
        if (currentCandle.high >= bollingerBands.upper) return false;
        
        const profitTarget = currentPrice * 1.10;
        if (profitTarget >= bollingerBands.upper) return false;

        // Restore the check for current candle high vs profit target
        if (currentCandle.high >= profitTarget || currentCandle.low <= bollingerBands.middle) return false;
        
        if (currentPrice <= openPrice) return false;

        const previousClose = this.priceHistory.get(symbol)?.slice(-2)[0]?.price;
        if (!previousClose || currentPrice <= previousClose) return false;
        
        return true;
    }

    cleanupPerformers() {
        // Keep only performers that have been seen in the last 2 days
        const twoDaysAgo = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000));
        
        // Remove old performers that have no recent activity
        this.allTimePerformers.forEach(symbol => {
            const hasRecentActivity = this.candidateHistory.has(symbol) &&
                this.candidateHistory.get(symbol).occurrences.some(time => 
                    new Date(time) >= twoDaysAgo
                );
            
            if (!hasRecentActivity) {
                this.allTimePerformers.delete(symbol);
                this.performerCounts.delete(symbol);
            }
        });
    }

    // Add new method to check for delisting
    async checkDelistingStatus(symbol) {
        try {
            const response = await fetch(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${symbol}`);
            const data = await response.json();
            
            if (data.retCode === 0 && data.result.list && data.result.list[0]) {
                const deliveryTime = parseInt(data.result.list[0].deliveryTime);
                if (deliveryTime !== 0) {
                    return false;
                }
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    formatCETTime() {
        const date = new Date();
        // Get time in CET
        const cetTime = date.toLocaleString('en-US', { 
            timeZone: 'Europe/Zagreb',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        
        // Fix 24:00 to 00:00 format
        const [hours, minutes, seconds] = cetTime.split(':');
        const formattedHours = hours === '24' ? '00' : hours;
        return `${formattedHours}:${minutes}:${seconds}`;
    }

    // Add this method to check if it's between 00:00 and 06:00 CET
    isQuietHours() {
        const now = new Date();
        const cetTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
        const cetHour = cetTime.getHours();
        return cetHour >= 0 && cetHour < 6;
    }

    // Add this method to send Telegram message
    async sendTelegramAlert(symbol, currentPrice) {
        if (this.isQuietHours()) return;
        
        if (!this.sentTelegramToday.has(symbol)) {
            const lowerPrice = (currentPrice * 0.15).toFixed(4);
            const higherPrice = (currentPrice * 5).toFixed(4);
            const cetTime = this.formatCETTime().slice(0, 5); // Get only HH:MM
            
            const message = `\nLEVERAGE 1X\nGEOMETRIC GRID\n900 GRIDS\n\n${symbol}\nLP-*${lowerPrice}*       HP-*${higherPrice}*\nTIME ${cetTime}`;
            
            try {
                await bot.sendMessage(TELEGRAM_GROUP_ID, message, { parse_mode: 'Markdown' });
                this.sentTelegramToday.add(symbol);
            } catch (error) {
                console.error('Telegram notification error:', error);
            }
        }
    }

    async processMinute() {
        try {
            const cetTime = this.formatCETTime();
            const scannerLog = `[Scanner] Symbol scanning started (10-second intervals) - CET: ${cetTime}`;
            console.log(scannerLog);
            this.resetDailyCounts();
            this.cleanupPerformers();
            await this.fetchTickers();
            this.calculateVolatility();
            // Get top 10 performers instead of just the best one
            const minVolume = 10000000; // $10M minimum 24h volume
            const top10Performers = Array.from(this.volatilityScores.entries())
                .filter(([symbol]) => this.volumes.get(symbol) >= minVolume)
                .sort(([symbolA, scoreA], [symbolB, scoreB]) => {
                    const scoreDiff = scoreB - scoreA;
                    if (Math.abs(scoreDiff) > 0.0001) {
                        return scoreDiff;
                    }
                    return this.volumes.get(symbolB) - this.volumes.get(symbolA);
                })
                .slice(0, 10); // Take top 10

            // Check each performer until we find one that meets trade criteria
            for (const [symbol] of top10Performers) {
                const timestamp = new Date();
                const priceHistory = this.priceHistory.get(symbol);
                const currentPrice = priceHistory?.slice(-1)[0]?.price;

                if (!currentPrice) continue;

                const historicalCandles = await this.fetchHistoricalCandles(symbol);
                if (historicalCandles && historicalCandles.length >= 2) {
                    const currentCandle = historicalCandles[0];
                    const previousCandle = historicalCandles[1];

                    const openPrice = currentCandle.open;
                    const previousClose = previousCandle.close;

                    if (currentPrice && openPrice && previousClose) {
                        const bollingerBands = this.calculateBollingerBands(historicalCandles);

                        const isNotDelisting = await this.checkDelistingStatus(symbol);
                        if (!isNotDelisting) continue;

                        const meetsTradeConditions = await this.checkTradeCriteria(
                            currentPrice,
                            bollingerBands,
                            openPrice,
                            symbol
                        );

                        if (meetsTradeConditions) {
                            const cetTime = this.formatCETTime();
                            const tradeLog = `${symbol} MEETS ALL TRADE CONDITIONS! - CET: ${cetTime}`;
                            console.log(tradeLog);
                            this.updateCandidateHistory(symbol, timestamp);

                            // Add Telegram notification
                            await this.sendTelegramAlert(symbol, currentPrice);

                            this.emit('bestPerformerFound', {
                                potentialCandidates: Array.from(this.candidateHistory.entries())
                                    .map(([symbol, history]) => ({
                                        symbol,
                                        price: this.priceHistory.get(symbol)?.slice(-1)[0]?.price,
                                        firstSeen: history.firstSeen,
                                        lastSeen: history.lastSeen,
                                        dailyCount: history.dailyCount
                                    })),
                                scannerLog: scannerLog,
                                tradeLog: tradeLog
                            });

                            // Stop searching once we find a valid signal
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Scanner] Error in processMinute:', error.message);
            this.hasErrorThisMinute = true;
        }
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.intervalId = setInterval(() => this.processMinute(), 10000);
            //console.log('[Scanner] Symbol scanning started (10-second intervals)');
        }
    }

    stop() {
        if (this.isRunning && this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            this.isRunning = false;
            
            this.priceHistory.clear();
            this.volatilityScores.clear();
            this.volumes.clear();
            this.fundingRates.clear();
            this.volumeHistory.clear();
            this.scoreHistory.clear();
            this.potentialCandidates.clear();
            this.candidateHistory.clear();
            this.allTimePerformers.clear();
            this.performerCounts.clear();
        }
    }

    getCurrentState() {
        // Get performers from performerCounts
        const performers = Array.from(this.allTimePerformers)
            .map(symbol => ({
                symbol,
                count: this.performerCounts.get(symbol) || 0,
                lastPrice: this.priceHistory.get(symbol)?.slice(-1)[0]?.price || 0
            }))
            .filter(item => item.lastPrice > 0)
            .sort((a, b) => b.count - a.count)
            .map(item => ({
                symbol: item.symbol,
                count: item.count,
                lowerPrice: (item.lastPrice * 0.15).toFixed(4),
                higherPrice: (item.lastPrice * 5).toFixed(4)
            }));

        const candidates = Array.from(this.candidateHistory.entries())
            .map(([symbol, history]) => {
                const price = this.priceHistory.get(symbol)?.slice(-1)[0]?.price || 0;
                return {
                    symbol,
                    price,
                    timestamp: history.firstSeen,
                    dailyCount: history.dailyCount
                };
            })
            .filter(candidate => candidate.price > 0)
            .sort((a, b) => b.dailyCount - a.dailyCount);

        return {
            lastResult: this.lastScannerResult,
            performers: performers,
            potentialCandidates: candidates
        };
    }
}

// Create scanner instance
const scanner = new SymbolScanner();

// Serve static files from 'public' directory
app.use(express.static('public'));

// Route for the welcome page
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

// WebSocket connection handling
io.on('connection', (socket) => {
    const candidateHistory = Array.from(scanner.candidateHistory.entries())
        .map(([symbol, history]) => ({
            symbol,
            price: scanner.priceHistory.get(symbol)?.slice(-1)[0]?.price,
            firstSeen: history.firstSeen,
            lastSeen: history.lastSeen,
            dailyCount: history.dailyCount
        }))
        .filter(candidate => candidate.price)
        .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    socket.emit('initialState', {
        potentialCandidates: candidateHistory
    });
    
    socket.on('disconnect', () => {});
});

// Listen for scanner events and broadcast to all clients
scanner.on('bestPerformerFound', (result) => {
    io.emit('scannerUpdate', result);
});

// Start the scanner
scanner.start();

// Start the server
const port = 3000;
http.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});















































































