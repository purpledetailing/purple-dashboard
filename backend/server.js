const express = require('express');
const cors = require('cors');
const vinRoutes = require('./routes/vin');

const app = express();
app.use(cors());
app.use(express.json());

// VIN routes
app.use('/api/vin', vinRoutes);

// Root route for testing
app.get('/', (req, res) => {
    res.send('Server is running!');
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
