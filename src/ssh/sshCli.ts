import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as stream from 'stream';
import Log from '../common/logger';
import { ISSHSession } from './sshSession';
import { AskpassServer } from './askpassServer';
import { isWindows } from '../common/platform';
import { findRandomPort } from '../common/ports';

/**
 * Configuration for establishing an SSH CLI session.
 *
 * When `hostAlias` is provided, it is used as the SSH target in all command
 * arguments so that `~/.ssh/config` Host blocks (ProxyJump, IdentityFile,
 * ServerAliveInterval, etc.) are correctly matched. Otherwise the resolved
 * `host` IP/hostname is used directly.
 */
export interface SSHCliConfig {
	/** Resolved hostname or IP address of the remote host. */
	host: string;
	/** Port number for the SSH connection. */
	port: number;
	/** Username for the SSH connection. */
	username: string;
	/**
	 * SSH config alias (e.g., `raspi`). When set, used as the SSH target
	 * instead of the resolved `host` so that `~/.ssh/config` Host blocks
	 * (ProxyJump, IdentityFile, ServerAliveInterval, etc.) are matched.
	 */
	hostAlias?: string;
	/** Additional SSH options (e.g., from ssh_config). */
	extraArgs?: string[];
	/** Custom path to the ssh binary (defaults to `ssh` in PATH). */
	sshPath?: string;
}

/**
 * SSH session implementation using the OS `ssh` binary.
 *
 * On macOS/Linux, uses ControlMaster for connection multiplexing.
 * On Windows, spawns individual ssh processes per operation (no ControlMaster).
 *
 * Advantages over the ssh2 library:
 * - Full SSH config support (~/.ssh/config)
 * - FIDO2/ed25519-sk key support
 * - GSSAPI/Kerberos authentication
 * - ControlMaster multiplexing (macOS/Linux)
 * - ProxyJump/ProxyCommand handled natively by OpenSSH
 */
export class SSHCli implements ISSHSession {
	private controlPath: string = '';
	private masterProcess: cp.ChildProcess | undefined;
	private askpassServer: AskpassServer;
	private askpassScript: string = '';
	private connected: boolean = false;
	private childProcesses: cp.ChildProcess[] = [];
	private readonly useControlMaster: boolean;
	private readonly sshBinary: string;

	constructor(
		private readonly config: SSHCliConfig,
		private readonly logger: Log,
		askpassServer: AskpassServer
	) {
		this.askpassServer = askpassServer;
		this.sshBinary = config.sshPath || 'ssh';
		this.useControlMaster = !isWindows;

		if (this.useControlMaster) {
			// Generate a short ControlMaster socket path.
			// Unix domain socket paths have a max length (104 on macOS, 108 on Linux).
			// OpenSSH may append a random suffix (~20 chars), so we keep our path very short.
			// Use /tmp directly (short) and a hash of the connection identity.
			const identity = `${this.config.username}@${this.config.host}:${this.config.port}:${process.pid}`;
			const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 8);
			this.controlPath = `/tmp/ors-${hash}`;
		}
	}

	/**
	 * Establish the SSH connection.
	 * On macOS/Linux: starts a ControlMaster for connection multiplexing.
	 * On Windows: verifies connectivity with a simple ssh command.
	 */
	async connect(): Promise<void> {
		if (this.connected) {
			return;
		}

		// Ensure askpass script is created
		await this.ensureAskpassScript();

		if (this.useControlMaster) {
			await this.connectWithControlMaster();
		} else {
			await this.connectDirect();
		}
	}

	/**
	 * Establish ControlMaster connection (macOS/Linux).
	 */
	private async connectWithControlMaster(): Promise<void> {
		const args = this.buildSSHArgs([
			'-o', 'ControlMaster=yes',
			'-o', `ControlPath=${this.controlPath}`,
			'-o', 'ControlPersist=yes',
			'-N', // No remote command
		]);

		this.logger.info(`Establishing ControlMaster connection: ${this.sshBinary} ${args.join(' ')}`);

		const env = this.buildEnv();

		await new Promise<void>((resolve, reject) => {
			const proc = cp.spawn(this.sshBinary, args, {
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			this.masterProcess = proc;

			let stderr = '';
			proc.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
				this.logger.trace(`[ControlMaster stderr] ${data.toString().trim()}`);
			});

			proc.on('error', (err) => {
				reject(new Error(`Failed to spawn ssh: ${err.message}`));
			});

			proc.on('exit', (code) => {
				// With ControlPersist=yes, ssh forks into background and exits with code 0.
				// This is expected behavior - only reject on non-zero exit codes.
				if (!this.connected && code !== 0) {
					reject(new Error(`SSH ControlMaster exited with code ${code}: ${stderr.trim()}`));
				}
			});

			// Wait for the control socket to appear
			this.waitForControlSocket(60)
				.then(() => {
					this.connected = true;
					this.logger.info('ControlMaster connection established');
					resolve();
				})
				.catch((err) => {
					proc.kill();
					reject(err);
				});
		});
	}

	/**
	 * Establish direct connection without ControlMaster (Windows).
	 * Verifies SSH connectivity by running a simple command.
	 */
	private async connectDirect(): Promise<void> {
		const args = this.buildSSHArgs([]);

		// Append a simple test command after user@host
		args.push('echo', 'ok');

		this.logger.info(`Verifying SSH connectivity (direct mode): ${this.sshBinary} ${args.join(' ')}`);

		const env = this.buildEnv();

		await new Promise<void>((resolve, reject) => {
			const proc = cp.spawn(this.sshBinary, args, {
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			let stderr = '';
			proc.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on('error', (err) => {
				reject(new Error(`Failed to spawn ssh: ${err.message}`));
			});

			proc.on('close', (code) => {
				if (code === 0) {
					this.connected = true;
					this.logger.info('SSH connectivity verified (direct mode)');
					resolve();
				} else {
					reject(new Error(`SSH connection test failed with code ${code}: ${stderr.trim()}`));
				}
			});
		});
	}

	/**
	 * Execute a command on the remote host.
	 */
	async exec(cmd: string): Promise<{ stdout: string; stderr: string }> {
		this.ensureConnected();

		const args = this.useControlMaster
			? this.buildMuxArgs([], cmd)
			: this.buildSSHArgs([], cmd);

		this.logger.trace(`Executing: ${this.sshBinary} ${args.join(' ')}`);

		return new Promise((resolve, reject) => {
			const proc = cp.spawn(this.sshBinary, args, {
				env: this.buildEnv(),
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			this.childProcesses.push(proc);

			let stdout = '';
			let stderr = '';

			proc.stdout?.on('data', (data: Buffer) => {
				stdout += data.toString();
			});

			proc.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on('error', (err) => {
				this.removeChildProcess(proc);
				reject(err);
			});

			proc.on('close', () => {
				this.removeChildProcess(proc);
				resolve({ stdout, stderr });
			});
		});
	}

	/**
	 * Execute a command and resolve early when tester returns true.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async execPartial(cmd: string, tester: (stdout: string, stderr: string) => boolean, _params?: Array<string>): Promise<{ stdout: string; stderr: string }> {
		this.ensureConnected();

		const args = this.useControlMaster
			? this.buildMuxArgs([], cmd)
			: this.buildSSHArgs([], cmd);

		this.logger.trace(`Executing (partial): ${this.sshBinary} ${args.join(' ')}`);

		return new Promise((resolve, reject) => {
			const proc = cp.spawn(this.sshBinary, args, {
				env: this.buildEnv(),
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			this.childProcesses.push(proc);

			let stdout = '';
			let stderr = '';
			let resolved = false;

			proc.stdout?.on('data', (data: Buffer) => {
				stdout += data.toString();
				if (!resolved && tester(stdout, stderr)) {
					resolved = true;
					resolve({ stdout, stderr });
				}
			});

			proc.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
				if (!resolved && tester(stdout, stderr)) {
					resolved = true;
					resolve({ stdout, stderr });
				}
			});

			proc.on('error', (err) => {
				this.removeChildProcess(proc);
				if (!resolved) {
					reject(err);
				}
			});

			proc.on('close', () => {
				this.removeChildProcess(proc);
				if (!resolved) {
					resolve({ stdout, stderr });
				}
			});
		});
	}

	/**
	 * Forward a TCP connection using ssh -W (stdio forwarding).
	 * Returns a bidirectional stream connected to destIP:destPort on the remote host.
	 */
	async forwardOut(_srcIP: string, _srcPort: number, destIP: string, destPort: number): Promise<stream.Duplex> {
		this.ensureConnected();

		const args = this.useControlMaster
			? this.buildMuxArgs(['-W', `${destIP}:${destPort}`])
			: this.buildSSHArgs(['-W', `${destIP}:${destPort}`]);

		this.logger.trace(`Forwarding out (stdio): ${this.sshBinary} ${args.join(' ')}`);

		const proc = cp.spawn(this.sshBinary, args, {
			env: this.buildEnv(),
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this.childProcesses.push(proc);

		proc.stderr?.on('data', (data: Buffer) => {
			this.logger.trace(`[forwardOut stderr] ${data.toString().trim()}`);
		});

		proc.on('exit', () => {
			this.removeChildProcess(proc);
		});

		// Create a Duplex stream that wraps the child process stdin/stdout
		const duplex = new stream.Duplex({
			read() {
				// Data is pushed from stdout listener
			},
			write(chunk, _encoding, callback) {
				if (proc.stdin?.writable) {
					proc.stdin.write(chunk, callback);
				} else {
					callback(new Error('SSH process stdin not writable'));
				}
			},
			final(callback) {
				proc.stdin?.end();
				callback();
			},
			destroy(err, callback) {
				proc.kill();
				callback(err);
			}
		});

		proc.stdout?.on('data', (data: Buffer) => {
			duplex.push(data);
		});

		proc.stdout?.on('end', () => {
			duplex.push(null);
		});

		proc.on('error', (err) => {
			duplex.destroy(err);
		});

		proc.on('close', () => {
			duplex.push(null);
		});

		return duplex;
	}

	/**
	 * Forward a connection to a remote Unix domain socket.
	 * Uses local port forwarding (-L) and connects a TCP socket to it.
	 */
	async forwardOutStreamLocal(socketPath: string): Promise<stream.Duplex> {
		this.ensureConnected();

		// Find a free local port for the forward
		const localPort = await findRandomPort();

		// Set up local port forwarding to the remote Unix socket
		const args = this.useControlMaster
			? this.buildMuxArgs(['-L', `${localPort}:${socketPath}`, '-N'])
			: this.buildSSHArgs(['-L', `${localPort}:${socketPath}`, '-N']);

		this.logger.trace(`Forwarding stream local: ${this.sshBinary} ${args.join(' ')}`);

		const proc = cp.spawn(this.sshBinary, args, {
			env: this.buildEnv(),
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this.childProcesses.push(proc);

		proc.stderr?.on('data', (data: Buffer) => {
			this.logger.trace(`[forwardOutStreamLocal stderr] ${data.toString().trim()}`);
		});

		proc.on('exit', () => {
			this.removeChildProcess(proc);
		});

		// Wait a short time for the port forward to establish
		await new Promise(resolve => setTimeout(resolve, 500));

		// Connect to the local forwarded port
		const socket = await this.connectToLocalPort(localPort);

		// Wrap the socket to also kill the ssh process on close
		const originalDestroy = socket.destroy.bind(socket);
		socket.destroy = (error?: Error) => {
			proc.kill();
			return originalDestroy(error);
		};

		return socket;
	}

	/**
	 * Check if the SSH session is still alive and usable.
	 * On macOS/Linux: verifies the ControlMaster socket with `-O check`.
	 * On Windows: checks the `connected` flag (no persistent connection to verify).
	 */
	isAlive(): boolean {
		if (!this.connected) {
			return false;
		}

		if (this.useControlMaster) {
			// Verify ControlMaster socket is responsive
			try {
				const result = cp.spawnSync(this.sshBinary, [
					'-o', `ControlPath=${this.controlPath}`,
					'-O', 'check',
					`${this.config.username}@${this.getSSHTarget()}`,
				], { timeout: 5000 });

				return result.status === 0;
			} catch {
				return false;
			}
		}

		// On Windows (direct mode), we can't cheaply verify connectivity
		// without spawning a new SSH process. Return `connected` flag as best effort.
		return this.connected;
	}

	/**
	 * Re-establish the SSH connection after a disconnect.
	 * Cleans up stale resources (dead ControlMaster, orphan processes)
	 * and creates a fresh connection.
	 */
	async reconnect(): Promise<void> {
		this.logger.info('Reconnecting SSH session...');

		// Kill any lingering child processes from the dead session
		for (const proc of this.childProcesses) {
			try { proc.kill(); } catch { /* ignore */ }
		}
		this.childProcesses = [];

		// Clean up stale ControlMaster (macOS/Linux)
		if (this.useControlMaster) {
			// Try graceful exit first (might fail if ControlMaster is unresponsive)
			try {
				cp.spawnSync(this.sshBinary, [
					'-o', `ControlPath=${this.controlPath}`,
					'-O', 'exit',
					`${this.config.username}@${this.getSSHTarget()}`,
				], { timeout: 3000 });
			} catch { /* ignore */ }

			// Kill master process if still tracked
			if (this.masterProcess) {
				try { this.masterProcess.kill(); } catch { /* ignore */ }
				this.masterProcess = undefined;
			}

			// Remove stale socket file
			try {
				if (fs.existsSync(this.controlPath)) {
					fs.unlinkSync(this.controlPath);
				}
			} catch { /* ignore */ }
		}

		// Reset state
		this.connected = false;

		// Re-establish the connection
		await this.connect();

		this.logger.info('SSH session reconnected successfully');
	}

	/**
	 * Close the SSH session and clean up all resources.
	 */
	async close(): Promise<void> {
		// Kill all child processes
		for (const proc of this.childProcesses) {
			try { proc.kill(); } catch { /* ignore */ }
		}
		this.childProcesses = [];

		if (!this.connected) {
			return;
		}

		// Send exit command to ControlMaster (macOS/Linux only)
		if (this.useControlMaster) {
			try {
				const args = [
					'-o', `ControlPath=${this.controlPath}`,
					'-O', 'exit',
					`${this.config.username}@${this.getSSHTarget()}`,
				];

				this.logger.trace(`Closing ControlMaster: ${this.sshBinary} ${args.join(' ')}`);

				cp.spawnSync(this.sshBinary, args, { timeout: 5000 });
			} catch (e) {
				this.logger.trace(`Error closing ControlMaster: ${e}`);
			}

			// Kill master process if still alive
			if (this.masterProcess) {
				try { this.masterProcess.kill(); } catch { /* ignore */ }
				this.masterProcess = undefined;
			}

			// Clean up control socket
			try {
				if (fs.existsSync(this.controlPath)) {
					fs.unlinkSync(this.controlPath);
				}
			} catch { /* ignore */ }
		}

		// Clean up askpass script
		if (this.askpassScript) {
			try { fs.unlinkSync(this.askpassScript); } catch { /* ignore */ }
		}

		this.connected = false;
	}

	// --- Private helpers ---

	/**
	 * Return the SSH target to use in command arguments.
	 * Prefers hostAlias (SSH config alias) so that ~/.ssh/config Host blocks are matched.
	 * Falls back to the resolved host when no alias is available.
	 */
	private getSSHTarget(): string {
		return this.config.hostAlias || this.config.host;
	}

	private ensureConnected(): void {
		if (!this.connected) {
			throw new Error('SSH session not connected. Call connect() first.');
		}
	}

	/**
	 * Build base SSH args common to all operations.
	 * No SSH options are overridden here — delegates all behavior to
	 * ~/.ssh/config and OpenSSH defaults for full user config respect.
	 * @param extraArgs - SSH options to place before user@host
	 * @param remoteCommand - Optional command to execute on the remote (placed after user@host)
	 */
	private buildSSHArgs(extraArgs: string[], remoteCommand?: string): string[] {
		const args: string[] = [
			'-p', this.config.port.toString(),
		];

		if (this.config.extraArgs) {
			args.push(...this.config.extraArgs);
		}

		args.push(...extraArgs);
		args.push(`${this.config.username}@${this.getSSHTarget()}`);

		if (remoteCommand) {
			args.push(remoteCommand);
		}

		return args;
	}

	/**
	 * Build SSH args for multiplexed operations (using ControlPath).
	 * @param sshOptions - SSH options to place before user@host
	 * @param remoteCommand - Optional command to execute on the remote (placed after user@host)
	 */
	private buildMuxArgs(sshOptions: string[], remoteCommand?: string): string[] {
		const args: string[] = [
			'-o', `ControlPath=${this.controlPath}`,
			'-o', 'ControlMaster=no',
			'-p', this.config.port.toString(),
		];

		args.push(...sshOptions);
		args.push(`${this.config.username}@${this.getSSHTarget()}`);

		if (remoteCommand) {
			args.push(remoteCommand);
		}

		return args;
	}

	/**
	 * Build environment variables for SSH process.
	 */
	private buildEnv(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env };

		if (this.askpassScript && this.askpassServer.port > 0) {
			env['SSH_ASKPASS'] = this.askpassScript;
			env['SSH_ASKPASS_REQUIRE'] = 'force';
			env['DISPLAY'] = ':0'; // Required for SSH_ASKPASS to be used
			env['SSH_ASKPASS_PORT'] = this.askpassServer.port.toString();
		}

		// Prevent SSH from reading from terminal directly
		// (forces use of SSH_ASKPASS)
		delete env['SSH_TERMINAL'];

		return env;
	}

	/**
	 * Wait for the ControlMaster socket file to appear.
	 */
	private async waitForControlSocket(timeoutSecs: number): Promise<void> {
		const startTime = Date.now();
		const timeoutMs = timeoutSecs * 1000;
		const pollInterval = 200; // ms

		while (Date.now() - startTime < timeoutMs) {
			if (fs.existsSync(this.controlPath)) {
				// Verify the socket is usable with -O check
				const result = cp.spawnSync(this.sshBinary, [
					'-o', `ControlPath=${this.controlPath}`,
					'-O', 'check',
					`${this.config.username}@${this.getSSHTarget()}`,
				], { timeout: 5000 });

				if (result.status === 0) {
					return;
				}
			}

			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}

		throw new Error(`Timed out waiting for ControlMaster socket after ${timeoutSecs}s`);
	}

	/**
	 * Ensure the askpass helper script exists.
	 */
	private async ensureAskpassScript(): Promise<void> {
		if (this.askpassScript && fs.existsSync(this.askpassScript)) {
			return;
		}

		const scriptDir = path.join(os.tmpdir(), 'open-remote-ssh');
		if (!fs.existsSync(scriptDir)) {
			fs.mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
		}

		if (isWindows) {
			this.askpassScript = path.join(scriptDir, `askpass-${process.pid}.cmd`);
			const content = `@echo off\r\ncurl -sf --data-urlencode "prompt=%~1" "http://127.0.0.1:%SSH_ASKPASS_PORT%/askpass"\r\n`;
			fs.writeFileSync(this.askpassScript, content, { mode: 0o700 });
		} else {
			this.askpassScript = path.join(scriptDir, `askpass-${process.pid}.sh`);
			const content = `#!/bin/sh\nexec curl -sf --data-urlencode "prompt=$1" "http://127.0.0.1:$SSH_ASKPASS_PORT/askpass"\n`;
			fs.writeFileSync(this.askpassScript, content, { mode: 0o755 });
		}

		this.logger.trace(`Askpass script created: ${this.askpassScript}`);
	}

	/**
	 * Connect to a local TCP port with retry.
	 */
	private async connectToLocalPort(port: number, retries: number = 10, delay: number = 200): Promise<net.Socket> {
		for (let i = 0; i < retries; i++) {
			try {
				return await new Promise<net.Socket>((resolve, reject) => {
					const socket = net.connect(port, '127.0.0.1', () => {
						resolve(socket);
					});
					socket.on('error', reject);
				});
			} catch {
				if (i === retries - 1) {
					throw new Error(`Failed to connect to local forwarded port ${port} after ${retries} attempts`);
				}
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}

		throw new Error(`Failed to connect to local forwarded port ${port}`);
	}

	private removeChildProcess(proc: cp.ChildProcess): void {
		const idx = this.childProcesses.indexOf(proc);
		if (idx >= 0) {
			this.childProcesses.splice(idx, 1);
		}
	}
}
