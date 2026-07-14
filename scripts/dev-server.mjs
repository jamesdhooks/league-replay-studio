import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const targets = {
  backend: {
    port: 6369,
    command: resolve('backend/venv/Scripts/python.exe'),
    args: [resolve('backend/app.py'), '--web', '--reload'],
    cwd: resolve('backend'),
    env: {
      ...process.env,
      WEB_ONLY: '1',
      LRS_PORT: '6369',
      LRS_OPEN_BROWSER: '0',
    },
  },
  frontend: {
    port: 5299,
    command: process.execPath,
    args: [resolve('frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5299'],
    cwd: resolve('frontend'),
  },
}

const targetName = process.argv[2]
const target = targets[targetName]

if (!target) {
  console.error('Usage: node scripts/dev-server.mjs <backend|frontend>')
  process.exit(1)
}

function listenerPids(port) {
  const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
  return [...new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 5 && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING')
      .map((parts) => parts[4])
      .filter((pid) => /^\d+$/.test(pid)),
  )]
}

for (const pid of listenerPids(target.port)) {
  console.log(`Stopping existing listener on port ${target.port} (PID ${pid})...`)
  spawnSync('taskkill.exe', ['/PID', pid, '/T', '/F'], { stdio: 'inherit' })
}

const child = spawn(target.command, target.args, {
  cwd: target.cwd,
  env: target.env,
  stdio: 'inherit',
  shell: false,
})
child.on('exit', (code) => process.exit(code ?? 0))
