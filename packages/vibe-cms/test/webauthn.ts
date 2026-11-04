/**
 * A software passkey authenticator for tests: makes "none" attestations and ES256 assertions the way
 * a browser and platform authenticator would, so the site's real WebAuthn checks run.
 */

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for(const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Just enough CBOR: unsigned and negative integers, byte and text strings, maps.
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, n: number): Uint8Array {
  if(n < 24) return Uint8Array.of((major << 5) | n);
  if(n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}

function cbor(value: Cbor): Uint8Array {
  if(typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if(typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if(value instanceof Uint8Array) return concat(head(2, value.length), value);
  return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** WebCrypto signs ECDSA as raw r‖s; WebAuthn wants DER. */
function der(raw: Uint8Array): Uint8Array {
  function int(bytes: Uint8Array) {
    let i = 0;
    while(i < bytes.length - 1 && bytes[i] === 0) i++;
    let trimmed: Uint8Array = bytes.slice(i);
    if(trimmed[0]! & 0x80) trimmed = concat(Uint8Array.of(0), trimmed);
    return concat(Uint8Array.of(0x02, trimmed.length), trimmed);
  }
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export class Authenticator {
  #keys = new Map<string, { pair: CryptoKeyPair, counter: number, userHandle?: string }>();

  constructor(private origin: string) {}

  get rpId() {
    return new URL(this.origin).hostname;
  }

  /** `navigator.credentials.create()`: the RegistrationResponseJSON a browser would send. */
  async create(options: { challenge: string, user: { id: string } }) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const id = crypto.getRandomValues(new Uint8Array(16));
    this.#keys.set(b64url(id), { pair, counter: 0, userHandle: options.user.id });
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const authData = concat(await sha256(this.rpId), Uint8Array.of(0x45), new Uint8Array(4), new Uint8Array(16), Uint8Array.of(0, id.length), id, cose);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {}
    };
  }

  /** `navigator.credentials.get()` with the first (or given) passkey: an AuthenticationResponseJSON. */
  async get(options: { challenge: string }, id = [...this.#keys.keys()][0]!) {
    const key = this.#keys.get(id)!;
    key.counter++;
    const authData = concat(await sha256(this.rpId), Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, key.counter));
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.pair.privateKey, signed as Uint8Array<ArrayBuffer>));
    return {
      id,
      rawId: id,
      type: "public-key",
      response: { authenticatorData: b64url(authData), clientDataJSON: b64url(clientDataJSON), signature: b64url(der(raw)), userHandle: key.userHandle },
      clientExtensionResults: {}
    };
  }
}
