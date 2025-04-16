// Initialize socket connection
const socket = io();

// Add terminal output handling
socket.on('terminalLog', function(data) {
    const terminalOutput = document.getElementById('terminalOutput');
    const logLine = document.createElement('div');
    logLine.textContent = data.message;
    
    // Clear any existing content
    terminalOutput.innerHTML = '';
    
    // Add new line and scroll to bottom
    terminalOutput.appendChild(logLine);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
});

function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false 
    });
}

// Function to update candidates table
function updateCandidatesTable(candidates) {
    console.log('Updating candidates table with:', candidates);
    const candidatesTableBody = document.getElementById('candidatesTableBody');
    candidatesTableBody.innerHTML = '';
    
    candidates.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    
    candidates.forEach(candidate => {
        const row = document.createElement('tr');
        
        // Add flash animation only for recent updates
        const lastUpdate = new Date(candidate.lastSeen);
        const isRecent = (Date.now() - lastUpdate) < 2000;
        if (isRecent) {
            row.classList.add('flash-animation');
            setTimeout(() => {
                row.classList.remove('flash-animation');
            }, 1000);
        }
        
        row.innerHTML = `
            <td>
                <a href="https://www.bybit.com/trade/usdt/${candidate.symbol}" 
                   target="_blank" 
                   class="symbol-link">
                    ${candidate.symbol}
                </a>
            </td>
            <td>${candidate.price ? (candidate.price * 0.15).toFixed(4) : 'N/A'}</td>
            <td>${candidate.price ? (candidate.price * 5).toFixed(4) : 'N/A'}</td>
            <td>${formatTimestamp(candidate.firstSeen)} / ${formatTimestamp(candidate.lastSeen)}</td>
            <td>${candidate.dailyCount}x</td>
        `;
        candidatesTableBody.appendChild(row);
    });
}

// Keep track of all candidates with their original timestamps
let allCandidates = new Map();

// Handle initial state when connecting
socket.on('initialState', function(data) {
    console.log('Received initial state:', data);
    if (data.potentialCandidates) {
        data.potentialCandidates.forEach(candidate => {
            // Only set timestamp if it's a new candidate
            if (!allCandidates.has(candidate.symbol)) {
                allCandidates.set(candidate.symbol, {
                    ...candidate,
                    timestamp: candidate.timestamp
                });
            }
        });
        updateCandidatesTable(Array.from(allCandidates.values()));
    }
});

// Handle ongoing scanner updates
socket.on('scannerUpdate', function(data) {
    console.log('Received scanner update:', data);
    if (data.potentialCandidates) {
        data.potentialCandidates.forEach(candidate => {
            // Preserve original timestamp if candidate exists
            if (!allCandidates.has(candidate.symbol)) {
                allCandidates.set(candidate.symbol, {
                    ...candidate,
                    timestamp: candidate.timestamp
                });
            } else {
                // Update other properties but keep original timestamp
                const existingCandidate = allCandidates.get(candidate.symbol);
                allCandidates.set(candidate.symbol, {
                    ...candidate,
                    timestamp: existingCandidate.timestamp
                });
            }
        });
        updateCandidatesTable(Array.from(allCandidates.values()));
    }
});

// Add styles
const style = document.createElement('style');
style.textContent = `
    .symbol-link {
        color: inherit;
        text-decoration: none;
        font-weight: bold;
    }
    .symbol-link:hover {
        color: #00ff88;
    }
    .ranking-item {
        transition: transform 0.2s ease;
    }
    .ranking-item:hover {
        transform: scale(1.02);
        background-color: #404040;
    }
`;
document.head.appendChild(style);
















