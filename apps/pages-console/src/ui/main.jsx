import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App.jsx';
import { BRAND_NAME } from './brand.js';
import { PreferencesProvider } from './preferences-context.jsx';
import './styles.css';

document.title = BRAND_NAME;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PreferencesProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PreferencesProvider>
  </React.StrictMode>
);
