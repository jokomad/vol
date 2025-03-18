import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fetch from 'node-fetch';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const http = createServer(app);
const io = new Server(http);

// Scanner code
class SymbolScanner extends EventEmitter {
    constructor() {
        super();
        this.priceHistory = new Map();
        this.volatilityScores = new Map();
        this.volumes = new Map();
        this.fundingRates = new Map();
        this.lastMinuteCheck = null;
        this.isRunning = false;
        this.intervalId = null;
        this.hasErrorThisMinute = false;
        this.history = []; // Add history array to store past results
        this.maxHistoryItems = 1440; // Keep last 10 results
    }

    reset() {
        this.priceHistory.clear();
        this.volatilityScores.clear();
        this.volumes.clear();
        this.fundingRates.clear();
        this.hasErrorThisMinute = false;
    }

    async fetchTickers() {
        try {
            const response = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
            const data = await response.json();

            const currentTime = new Date();
            
            data.result.list.forEach(ticker => {
                if (ticker.symbol.endsWith('USDT')) {
                    const price = parseFloat(ticker.lastPrice);
                    const volume = parseFloat(ticker.turnover24h);
                    const fundingRate = parseFloat(ticker.fundingRate);
                    
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

        } catch (error) {
            this.hasErrorThisMinute = true;
            console.error('Error scanning tickers:', error.message);
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

        return {
            symbol,
            moves: Math.round(score * 100),
            volume24h: volume24h.toFixed(2),
            fundingRate: fundingRate.toFixed(4),
            lastPrice: lastPrice,
            hasError: this.hasErrorThisMinute
        };
    }

    async processMinute() {
        const now = new Date();
        const seconds = now.getSeconds();
        
        if (seconds === 0) {
            this.reset();
            console.log(`[Scanner] Starting new minute - ${now.toLocaleTimeString('en-US', { hour12: false })}`);
        }
        
        if (seconds < 59) {
            await this.fetchTickers();
            this.calculateVolatility();
        }
        
        if (seconds === 59) {
            const result = await this.findBestPerformer();
            if (!result.hasError && result.symbol) {
                result.timestamp = now.toLocaleTimeString('en-GB', { 
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
                
                // Add to history and maintain maxHistoryItems limit
                this.history.unshift(result);
                if (this.history.length > this.maxHistoryItems) {
                    this.history.pop();
                }
                
                console.log(`[Scanner] ${now.toLocaleTimeString('en-US', { hour12: false })} - Best performer: ${result.symbol} (${result.moves} moves)`);
                this.emit('bestPerformerFound', {
                    current: result,
                    history: this.history.slice(1) // Send all except current result
                });
            }
        }
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.intervalId = setInterval(() => this.processMinute(), 1000);
            console.log('[Scanner] Symbol scanning started');
        }
    }

    stop() {
        if (this.isRunning && this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            this.isRunning = false;
            console.log('[Scanner] Symbol scanning stopped');
        }
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
    console.log('Client connected');
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
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






