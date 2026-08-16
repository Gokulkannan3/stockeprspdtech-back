// Router/Godown.router.js
const express = require('express');
const router = express.Router();
const {
  addGodown,
  getGodowns,
  deleteGodown,
  addStockToGodown,
  getStockByGodown,
  takeStockFromGodown,
  getStockHistory,
  exportGodownStockToExcel,
  addStockToExisting,
  editGodown,
  getGodownsFast,
  bulkAllocate,
  deleteStockEntry,
  transferStock,
  getTransferChallans,
  getTransferChallanPDF,
  getGodownSnapshot,
  getGodownSummaryReport,
} = require('../Controller/Godown.controller');

router.post('/godowns', addGodown);
router.get('/godowns', getGodowns);
router.delete('/godowns/:id', deleteGodown);

router.post('/godowns/:godown_id/stock', addStockToGodown);
router.get('/godowns/:godown_id/stock', getStockByGodown);
router.patch('/godowns/stock/take', takeStockFromGodown);
router.patch('/godowns/stock/add', addStockToExisting);

router.get('/stock/:stock_id/history', getStockHistory);
router.get('/godowns/export-excel', exportGodownStockToExcel);
router.patch('/godowns/:id', editGodown);
router.get('/godowns/fast', getGodownsFast);
router.post('/godowns/bulk-allocate', bulkAllocate);
router.delete('/godowns/:godown_id/stock/:stock_id', deleteStockEntry);

// Transfer
router.post('/stock/transfer', transferStock);
router.post('/godowns/:sourceGodownId/stock/:stockId/transfer', transferStock);

// Transfer Challans
router.get('/transfer-challans', getTransferChallans);
router.get('/transfer-challans/:id/pdf', getTransferChallanPDF);

// Godown Snapshot (stock at a specific date)
router.get('/godown/:godown_id/snapshot', getGodownSnapshot);

// Reports
router.get('/reports/godown-summary', getGodownSummaryReport);

module.exports = router;