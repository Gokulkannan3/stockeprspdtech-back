const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  ssl: {
    rejectUnauthorized: false,
  },
});

const loginUser = async (req, res) => {
  const { username, password } = req.body;

  try {
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await pool.query(
      'SELECT username, type FROM public.user WHERE username = $1 AND password = $2',
      [username, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];
    res.status(200).json({
      message: 'Login successful',
      username: user.username,
      type: user.type,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const registerUser = async (req, res) => {
  const { username, password, type } = req.body;

  if (!username || !password || !type) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (!['admin', 'agent', 'worker'].includes(type)) {
    return res.status(400).json({ error: 'Invalid user type' });
  }

  try {
    const exists = await pool.query('SELECT 1 FROM public.user WHERE username = $1', [username]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    await pool.query(
      'INSERT INTO public.user (username, password, type) VALUES ($1, $2, $3)',
      [username, password, type]
    );

    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add this function
const changePassword = async (req, res) => {
  const { username, newPassword } = req.body;

  if (!username || !newPassword) {
    return res.status(400).json({ error: 'Username and new password are required' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  try {
    const result = await pool.query(
      'UPDATE public.user SET password = $1 WHERE username = $2 RETURNING username',
      [newPassword, username]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Also add endpoint to get list of users (for admin dropdown)
const getAllUsers = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT username, type FROM public.user ORDER BY username'
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

module.exports = {
  loginUser,
  registerUser,
  changePassword,
  getAllUsers,
};