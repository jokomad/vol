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

class PriceScanner extends EventEmitter {
    constructor() {
        super();
        this.lastPrices = new Map();
        this.historyUp = [];
        this.historyDown = [];
        this.isRunning = false;
        this.intervalId = null;
    }

    reset() {
        this.historyUp = [];
        this.historyDown = [];
    }

    async fetchMarketData() {
        try {
            const response = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
            const data = await response.json();
            return data.result.list
                .filter(item => 
                    item.symbol.endsWith('USDT') && 
                    parseFloat(item.turnover24h) > 10000000 && // Filter for turnover > 10M
                    parseFloat(item.deliveryTime) === 0 // Filter for deliveryTime = 0
                )
                .map(item => ({
                    symbol: item.symbol,
                    lastPrice: parseFloat(item.lastPrice),
                    turnover24h: parseFloat(item.turnover24h)
                }));
        } catch (error) {
            console.error('Error fetching market data:', error);
            return [];
        }
    }

    getUTC1Time() {
        const now = new Date();
        return new Date(now.getTime() + (2 * 60 * 60 * 1000));
    }

    async checkPrices() {
        const currentData = await this.fetchMarketData();
        let updates = { up: null, down: null };

        currentData.forEach(item => {
            const lastPrice = this.lastPrices.get(item.symbol);
            if (lastPrice) {
                const priceChange = ((item.lastPrice - lastPrice) / lastPrice) * 100;
                const time = this.getUTC1Time().toLocaleTimeString('en-GB', { 
                    hour12: false, 
                    timeZone: 'UTC' 
                });

                if (priceChange >= 1) {
                    updates.up = {
                        symbol: item.symbol,
                        priceChange: priceChange,
                        time: time
                    };
                    this.historyUp.unshift({
                        symbol: item.symbol,
                        increase: priceChange,
                        time: time
                    });
                }
                else if (priceChange <= -1) {
                    updates.down = {
                        symbol: item.symbol,
                        priceChange: priceChange,
                        time: time
                    };
                    this.historyDown.unshift({
                        symbol: item.symbol,
                        increase: priceChange,
                        time: time
                    });
                }
            }
            this.lastPrices.set(item.symbol, item.lastPrice);
        });

        if (updates.up || updates.down) {
            this.emit('priceUpdate', {
                current: updates,
                history: {
                    up: this.historyUp,
                    down: this.historyDown
                }
            });
        }
    }

    async initializePrices() {
        const data = await this.fetchMarketData();
        data.forEach(item => {
            this.lastPrices.set(item.symbol, item.lastPrice);
        });
    }

    checkDayReset() {
        const now = this.getUTC1Time();
        if (now.getHours() === 0 && now.getMinutes() === 0 && now.getSeconds() === 0) {
            this.reset();
            console.log('[Scanner] Daily reset performed at UTC+1 midnight');
        }
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.initializePrices().then(() => {
                this.intervalId = setInterval(() => this.checkPrices(), 1000);
                setInterval(() => this.checkDayReset(), 1000);
                console.log('[Scanner] Price scanning started');
            });
        }
    }

    stop() {
        if (this.isRunning && this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            this.isRunning = false;
            console.log('[Scanner] Price scanning stopped');
        }
    }
}

// Create scanner instance
const scanner = new PriceScanner();

// Serve static files from 'public' directory
app.use(express.static('public'));

// Route for the main page
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

// WebSocket connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Send current history on connection
    socket.emit('initialData', {
        history: {
            up: scanner.historyUp,
            down: scanner.historyDown
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Listen for scanner events and broadcast to all clients
scanner.on('priceUpdate', (data) => {
    io.emit('priceUpdate', data);
});

// Start the scanner
scanner.start();

// Start the server
const port = process.env.PORT || 3000;
http.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});


