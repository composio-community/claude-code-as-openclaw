import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const LABEL = 'com.openclaudeclaw.gateway'
const SERVICE_NAME = 'openclaudeclaw-gateway'

/**
 * Install/uninstall the gateway as an OS-level daemon.
 *   macOS  -> launchd LaunchAgent (~/Library/LaunchAgents/)
 *   Linux  -> systemd user service (~/.config/systemd/user/)
 */

export async function installDaemon() {
  const platform = os.platform()

  if (platform === 'darwin') {
    return installLaunchd()
  } else if (platform === 'linux') {
    return installSystemd()
  }

  throw new Error(`Daemon install not supported on ${platform}. Run "openclaudeclaw gateway start" manually.`)
}

export async function uninstallDaemon() {
  const platform = os.platform()

  if (platform === 'darwin') {
    return uninstallLaunchd()
  } else if (platform === 'linux') {
    return uninstallSystemd()
  }

  throw new Error(`Daemon uninstall not supported on ${platform}.`)
}

// --- macOS launchd ---

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

async function installLaunchd() {
  const cliPath = await resolveCliBin()
  const logDir = path.join(os.homedir(), '.claude', 'gateway', 'logs')
  await fs.mkdir(logDir, { recursive: true })

  const nodePath = process.execPath
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>gateway</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, 'gateway.stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, 'gateway.stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
  </dict>
</dict>
</plist>`

  const plistPath = launchdPlistPath()
  await fs.mkdir(path.dirname(plistPath), { recursive: true })
  await fs.writeFile(plistPath, plist)

  // Unload first if already loaded (ignore errors)
  try {
    await execFileAsync('launchctl', ['unload', plistPath])
  } catch { /* ok */ }

  await execFileAsync('launchctl', ['load', plistPath])
  return {
    type: 'launchd',
    plistPath,
    logDir,
    message: `Daemon installed. Gateway will start on login and restart on crash.\nLogs: ${logDir}`,
  }
}

async function uninstallLaunchd() {
  const plistPath = launchdPlistPath()
  try {
    await execFileAsync('launchctl', ['unload', plistPath])
  } catch { /* ok */ }

  try {
    await fs.unlink(plistPath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  return { message: 'Daemon uninstalled.' }
}

// --- Linux systemd ---

function systemdUnitPath() {
  return path.join(
    os.homedir(),
    '.config',
    'systemd',
    'user',
    `${SERVICE_NAME}.service`,
  )
}

async function installSystemd() {
  const cliPath = await resolveCliBin()

  const unit = `[Unit]
Description=OpenClaudeClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${cliPath} gateway start
Restart=on-failure
RestartSec=5
Environment=PATH=${process.env.PATH}
Environment=HOME=${os.homedir()}

[Install]
WantedBy=default.target
`

  const unitPath = systemdUnitPath()
  await fs.mkdir(path.dirname(unitPath), { recursive: true })
  await fs.writeFile(unitPath, unit)

  await execFileAsync('systemctl', ['--user', 'daemon-reload'])
  await execFileAsync('systemctl', ['--user', 'enable', SERVICE_NAME])
  await execFileAsync('systemctl', ['--user', 'start', SERVICE_NAME])

  return {
    type: 'systemd',
    unitPath,
    message: `Daemon installed. Check status: systemctl --user status ${SERVICE_NAME}`,
  }
}

async function uninstallSystemd() {
  try {
    await execFileAsync('systemctl', ['--user', 'stop', SERVICE_NAME])
  } catch { /* ok */ }
  try {
    await execFileAsync('systemctl', ['--user', 'disable', SERVICE_NAME])
  } catch { /* ok */ }

  const unitPath = systemdUnitPath()
  try {
    await fs.unlink(unitPath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  await execFileAsync('systemctl', ['--user', 'daemon-reload'])
  return { message: 'Daemon uninstalled.' }
}

// --- Helpers ---

async function resolveCliBin() {
  // Try to find the openclaudeclaw/claude binary
  // 1. Check if we're running from a known path
  const thisScript = process.argv[1]
  if (thisScript) {
    // Go up from gateway/cli.js to find the parent CLI
    const candidateBin = path.resolve(thisScript)
    try {
      await fs.access(candidateBin)
      return candidateBin
    } catch { /* fall through */ }
  }

  // 2. Use `which` to find claude or openclaudeclaw in PATH
  for (const bin of ['openclaudeclaw', 'claude']) {
    try {
      const { stdout } = await execFileAsync('which', [bin])
      const resolved = stdout.trim()
      if (resolved) return resolved
    } catch { /* try next */ }
  }

  // 3. Default to node + this script
  return process.execPath
}
