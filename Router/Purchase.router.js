const express = require('express');
const router = express.Router();
const {
  createPurchase,
  getPurchases,
  getPurchaseById,
  editPurchase,
  deletePurchase,
  getPurchasePDF,
  getPurchaseLedger,
  recordPurchasePayment,
  getPurchasePending,
  createPurchaseDispatch,
  getAllPurchaseDispatchLogs,
  getPurchaseDispatchLogs,
  getSuppliers,
  getSupplierBills,
  closePurchaseBill,
} = require('../Controller/Purchase.controller');

router.post('/purchase', createPurchase);
router.get('/purchase', getPurchases);
router.get('/purchase/pdf/:id', getPurchasePDF);
router.get('/purchase/:id', getPurchaseById);
router.patch('/purchase/:id', editPurchase);
router.delete('/purchase/:id', deletePurchase);

// Ledger & payments
router.get('/spurchase', getPurchaseLedger);
router.post('/purchase-payment', recordPurchasePayment);
router.get('/purchase-pending', getPurchasePending);

// Suppliers (Select Party dropdown)
router.get('/purchase-suppliers', getSuppliers);

// Supplier-level bill tally (grouped or per supplier with ?supplier=NAME)
router.get('/purchase-supplier-bills', getSupplierBills);

// Admin close/reopen a bill
router.patch('/purchase-close/:id', closePurchaseBill);

// Dispatch
router.post('/purchase-dispatch', createPurchaseDispatch);
router.get('/purchase-dispatch-logs/all', getAllPurchaseDispatchLogs);
router.get('/purchase-dispatch-logs/:purchase_id', getPurchaseDispatchLogs);

module.exports = router;
