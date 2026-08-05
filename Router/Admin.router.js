const express = require('express');
const router = express.Router();
const authController = require('../Controller/Admin.controller');

router.post('/login', authController.loginUser);
router.post('/register', authController.registerUser);
router.post('/change-password', authController.changePassword);
router.get('/users', authController.getAllUsers);   // only admin should access this

module.exports = router;