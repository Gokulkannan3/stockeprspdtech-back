const express = require('express');
const router = express.Router();
const {
  getGodownStockReport,
  getPurchaseReport,
  getTransferLogReport,
  getSupplierOutstandingReport,
  getCustomerList,
  getDealerAbstractReport,
} = require('../Controller/Reports.controller');

router.get('/reports/godown-stock', getGodownStockReport);
router.get('/reports/purchase-history', getPurchaseReport);
router.get('/reports/transfer-log', getTransferLogReport);
router.get('/reports/supplier-outstanding', getSupplierOutstandingReport);
router.get('/reports/customers', getCustomerList);
router.get('/reports/dealer-abstract', getDealerAbstractReport);

module.exports = router;
