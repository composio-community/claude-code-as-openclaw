import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)
const TOKEN_FILE = path.join(os.homedir(), '.claude', 'gateway', 'mcp_tokens.json')

/**
 * Standalone MCP OAuth2 PKCE flow.
 * No LLM involved — just browser auth.
 *
 * 1. Discovers OAuth metadata from MCP server
 * 2. Registers client dynamically (RFC 7591)
 * 3. Opens browser for PKCE authorization
 * 4. Receives callback with auth code
 * 5. Exchanges code for tokens
 * 6. Stores tokens for gateway use
 */

export async function authenticateMCP(serverName, serverUrl) {
  console.log(`  Discovering OAuth config from ${serverUrl}...`)

  // Step 1: Probe server to get WWW-Authenticate or well-known metadata
  const metadata = await discoverOAuthMetadata(serverUrl)
  if (!metadata) {
    throw new Error('Server does not support OAuth — no metadata found')
  }

  console.log(`  Found auth server: ${metadata.issuer ?? metadata.authorization_endpoint}`)

  const port = await findPort()
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const client = await registerClient(metadata, serverUrl, redirectUri)
  console.log(`  Client registered: ${client.client_id.slice(0, 12)}...`)

  // Step 3: PKCE + Authorization URL
  const codeVerifier = base64url(randomBytes(32))
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())
  const state = base64url(randomBytes(16))

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  if (metadata.scopes_supported?.length) {
    params.set('scope', metadata.scopes_supported.join(' '))
  }

  const authUrl = `${metadata.authorization_endpoint}?${params}`

  // Step 4: Start callback server + open browser
  const code = await waitForCallback(port, state, authUrl)

  // Step 5: Exchange code for tokens
  console.log(`  Exchanging authorization code for tokens...`)
  const tokens = await exchangeCode(metadata, client, code, redirectUri, codeVerifier)

  // Step 6: Save tokens
  await saveTokens(serverName, {
    serverUrl,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    clientId: client.client_id,
    clientSecret: client.client_secret ?? null,
    tokenEndpoint: metadata.token_endpoint,
  })

  console.log(`  Authenticated successfully.`)
}

// --- OAuth Discovery ---

async function discoverOAuthMetadata(serverUrl) {
  const base = new URL(serverUrl)

  // Try RFC 8414 well-known
  for (const wellKnown of [
    `${base.origin}/.well-known/oauth-authorization-server`,
    `${base.origin}/.well-known/openid-configuration`,
  ]) {
    try {
      const res = await fetch(wellKnown)
      if (res.ok) {
        const data = await res.json()
        if (data.authorization_endpoint && data.token_endpoint) return data
      }
    } catch { /* try next */ }
  }

  // Try probing the MCP endpoint for 401 with WWW-Authenticate
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    })
    if (res.status === 401) {
      const wwwAuth = res.headers.get('www-authenticate') ?? ''
      const resourceMetadata = extractParam(wwwAuth, 'resource_metadata')
      if (resourceMetadata) {
        const rmRes = await fetch(resourceMetadata)
        if (rmRes.ok) {
          const rm = await rmRes.json()
          if (rm.authorization_servers?.[0]) {
            const asRes = await fetch(`${rm.authorization_servers[0]}/.well-known/oauth-authorization-server`)
            if (asRes.ok) return asRes.json()
          }
        }
      }
    }
  } catch { /* fall through */ }

  return null
}

// --- Dynamic Client Registration (RFC 7591) ---

async function registerClient(metadata, serverUrl, redirectUri) {
  if (!metadata.registration_endpoint) {
    throw new Error('Server does not support Dynamic Client Registration')
  }

  const res = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'OpenClaudeClaw Gateway',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Client registration failed: ${res.status} ${body.slice(0, 200)}`)
  }

  return res.json()
}

// --- Callback Server ---

function waitForCallback(port, expectedState, authUrl) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Authentication Failed</h1><p>You can close this window.</p>')
        server.close()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<h1>Invalid State</h1><p>Please try again.</p>')
        server.close()
        reject(new Error('OAuth state mismatch'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h1>Authenticated!</h1><p>You can close this window and return to the terminal.</p>')
      server.close()
      resolve(code)
    })

    server.listen(port, '127.0.0.1', async () => {
      console.log(`  Opening browser for authentication...`)
      await openBrowser(authUrl)
      console.log(`  Waiting for OAuth callback on port ${port}...`)
    })

    // 5 min timeout
    setTimeout(() => {
      server.close()
      reject(new Error('Authentication timed out'))
    }, 5 * 60 * 1000)
  })
}

// --- Token Exchange ---

async function exchangeCode(metadata, client, code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: codeVerifier,
  })

  const res = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed: ${res.status} ${text.slice(0, 200)}`)
  }

  return res.json()
}

// --- Token Storage ---

async function loadTokens() {
  try {
    const raw = await fs.readFile(TOKEN_FILE, 'utf8')
    return JSON.parse(raw)
  } catch { return {} }
}

async function saveTokens(serverName, tokenData) {
  const tokens = await loadTokens()
  tokens[serverName] = tokenData
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true })
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2))
}

export async function getTokens(serverName) {
  const tokens = await loadTokens()
  return tokens[serverName] ?? null
}

// --- Utilities ---

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function extractParam(header, param) {
  const match = header.match(new RegExp(`${param}="([^"]+)"`))
  return match?.[1] ?? null
}

async function findPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    await execFileAsync(cmd, [url])
  } catch {
    console.log(`  Could not open browser. Open this URL manually:\n  ${url}`)
  }
}
