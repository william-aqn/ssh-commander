import React, { useState } from 'react';

const LoginForm = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    .then(res => {
      return res.text().then(text => {
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }

        if (res.ok && data) {
          return data;
        } else {
          return Promise.reject(data?.message || 'Invalid credentials');
        }
      });
    })
    .then(data => onLogin(data.username, data.userId))
    .catch(err => setError(err.toString()));
  };

  return (
    <div className="login-container">
      <form onSubmit={handleSubmit} className="login-form">
        <h2 className="login-title">Terminal Login</h2>
        {error && <div className="login-error">{error}</div>}
        <div className="login-field">
          <label className="login-label">USERNAME</label>
          <input 
            type="text" 
            value={username} 
            onChange={e => setUsername(e.target.value)}
            className="login-input"
          />
        </div>
        <div className="login-field password">
          <label className="login-label">PASSWORD</label>
          <input 
            type="password" 
            value={password} 
            onChange={e => setPassword(e.target.value)}
            className="login-input"
          />
        </div>
        <button type="submit" className="login-button">
          SIGN IN
        </button>
      </form>
    </div>
  );
};

export default LoginForm;
