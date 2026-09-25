export function installWebAuthnGuard() {
  try {
    const refuse = () => Promise.reject(new DOMException('Passkeys and security keys are disabled in WebCapture.', 'NotAllowedError'));
    const credentials = navigator.credentials;
    if (credentials) {
      const originalGet = typeof credentials.get === 'function' ? credentials.get.bind(credentials) : null;
      const originalCreate = typeof credentials.create === 'function' ? credentials.create.bind(credentials) : null;
      const wantsPublicKey = (options) => Boolean(options && typeof options === 'object' && options.publicKey);
      const define = (name, value) => { try { Object.defineProperty(credentials, name, { configurable: true, writable: true, value }); } catch {} };
      define('get', function get(options) { return wantsPublicKey(options) || !originalGet ? refuse() : originalGet(options); });
      define('create', function create(options) { return wantsPublicKey(options) || !originalCreate ? refuse() : originalCreate(options); });
    }
    const PublicKey = window.PublicKeyCredential;
    if (PublicKey) {
      const answers = { isConditionalMediationAvailable: false, isUserVerifyingPlatformAuthenticatorAvailable: false };
      for (const [name, answer] of Object.entries(answers)) {
        try { Object.defineProperty(PublicKey, name, { configurable: true, writable: true, value: () => Promise.resolve(answer) }); } catch {}
      }
      try { Object.defineProperty(PublicKey, 'getClientCapabilities', { configurable: true, writable: true, value: () => Promise.resolve({}) }); } catch {}
    }
  } catch {}
}

export const WEBAUTHN_GUARD_SOURCE = `(${installWebAuthnGuard.toString()})();`;
