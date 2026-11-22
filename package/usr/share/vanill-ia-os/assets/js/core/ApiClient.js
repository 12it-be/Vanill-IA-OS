/**
 * ==============================================================================
 * Vanill-IA OS — Fetch Wrapper with Automatic CSRF, Lock & Offline Detection
 * ==============================================================================
 */

export class ApiError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export class ApiClient {
  constructor() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    this.csrfToken = meta ? meta.getAttribute('content') || '' : '';
  }

  setCsrfToken(token) {
    if (typeof token === 'string' && token.length > 0) {
      this.csrfToken = token;
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) {
        meta.setAttribute('content', token);
      }
    }
  }

  async request(endpoint, { method = 'GET', body = null, signal = undefined, silentLock = false } = {}) {
    const headers = {
      Accept: 'application/json',
    };

    if (method !== 'GET' && method !== 'HEAD') {
      headers['X-CSRF-Token'] = this.csrfToken;
    }

    const fetchOptions = {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    };

    if (body !== null) {
      if (body instanceof FormData) {
        fetchOptions.body = body;
      } else {
        headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(body);
      }
    }

    let response;
    try {
      response = await fetch(endpoint, fetchOptions);
    } catch (networkErr) {
      window.dispatchEvent(new CustomEvent('vanillia:network-offline', { detail: { endpoint } }));
      throw new ApiError('NETWORK_OFFLINE', 'Serveur injoignable. Vérifiez votre connexion réseau.', 0);
    }

    window.dispatchEvent(new CustomEvent('vanillia:network-online'));

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      throw new ApiError('INVALID_SERVER_RESPONSE', `Réponse serveur invalide (HTTP ${response.status}).`, response.status);
    }

    if (!response.ok || !payload || payload.ok !== true) {
      const errObj = (payload && payload.error) || {};
      const code = errObj.code || 'API_ERROR';
      const message = errObj.message || `Erreur HTTP ${response.status}`;

      if (response.status === 423 || code === 'SESSION_LOCKED') {
        if (!silentLock) {
          window.dispatchEvent(new CustomEvent('vanillia:session-locked'));
        }
      } else if (response.status === 401 && code === 'UNAUTHENTICATED') {
        window.dispatchEvent(new CustomEvent('vanillia:auth-expired'));
      }

      throw new ApiError(code, message, response.status, errObj);
    }

    if (payload.data && typeof payload.data.csrf_token === 'string') {
      this.setCsrfToken(payload.data.csrf_token);
    }

    return payload.data;
  }

  get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  post(endpoint, body = {}, options = {}) {
    return this.request(endpoint, { ...options, method: 'POST', body });
  }

  delete(endpoint, body = {}, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE', body });
  }
}

export const api = new ApiClient();
