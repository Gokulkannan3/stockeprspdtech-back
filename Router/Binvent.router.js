const express = require('express');
const router = express.Router();
const {
  addProduct,
  getAllProducts,
  searchProducts,
  checkProductExists,
  getProductTypes,
  addFromPurchase,
  updateProduct,
  deleteProduct,
  getStates
} = require('../Controller/Binvent.controller');

router.post('/tproducts', addProduct);
router.get('/tproducts', getAllProducts);
router.get('/tproducts/search', searchProducts);
router.get('/tproducts/check', checkProductExists);
router.get('/product-types', getProductTypes);
router.post('/tproducts/add-from-purchase', addFromPurchase);
router.put('/tproducts/:id', updateProduct);
router.delete('/tproducts/:id', deleteProduct);
router.get('/states', getStates);

module.exports = router;