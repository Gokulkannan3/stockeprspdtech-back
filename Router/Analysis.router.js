// Router/Analysis.router.js
const express = require('express');
const router = express.Router();
const { getStockAnalysis, getPerformanceAnalysis, getProductTallyLedger } = require('../Controller/Analysis.controller');

router.get('/stock-analysis', getStockAnalysis);
router.get('/performance-analysis', getPerformanceAnalysis);
router.get('/product-tally-ledger', getProductTallyLedger);

module.exports = router;