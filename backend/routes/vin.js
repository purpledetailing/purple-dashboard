const express = require('express');
const router = express.Router();

// Test VIN route
router.post('/lookup', (req, res) => {
    const { vin } = req.body;
    if (!vin) return res.status(400).json({ error: 'VIN required' });

    // For testing, return a static record
    const testRecord = {
        vin: vin,
        name: 'John Doe',
        address: '123 Main St, Raleigh, NC',
        service_date: '2024-06-15',
        service_type: 'Full Ceramic Coating',
        notes: 'Customer prefers maintenance every 2 months'
    };

    res.json([testRecord]);
});

module.exports = router;
