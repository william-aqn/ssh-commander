import React, { useState, useEffect } from 'react';

const RetryTimer = ({ onRetry, seconds = 2 }) => {
  const [timeLeft, setTimeLeft] = useState(seconds);

  useEffect(() => {
    if (timeLeft <= 0) {
      onRetry();
      return;
    }
    const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft, onRetry]);

  return (
    <button 
      onClick={onRetry}
      className="retry-button"
    >
      Переподключиться ({timeLeft}с)
    </button>
  );
};

export default RetryTimer;
