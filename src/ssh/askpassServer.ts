import * as http from 'http';
import * as vscode from 'vscode';
import Log from '../common/logger';
import { findRandomPort } from '../common/ports';

/**
 * A local HTTP server that handles SSH_ASKPASS requests.
 *
 * When SSH needs a password or passphrase, it invokes the SSH_ASKPASS program.
 * Our askpass script sends an HTTP request to this server, which shows a
 * VS Code input box and returns the user's response.
 */
export class AskpassServer {
	private server: http.Server | undefined;
	private _port: number = 0;

	constructor(private readonly logger: Log) {}

	get port(): number {
		return this._port;
	}

	async start(): Promise<void> {
		if (this.server) {
			return;
		}

		this._port = await findRandomPort();

		this.server = http.createServer(async (req, res) => {
			if (req.url?.startsWith('/askpass')) {
				await this.handleAskpass(req, res);
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		await new Promise<void>((resolve, reject) => {
			this.server!.on('error', reject);
			this.server!.listen(this._port, '127.0.0.1', () => {
				this.logger.trace(`Askpass server listening on port ${this._port}`);
				resolve();
			});
		});
	}

	stop(): void {
		if (this.server) {
			this.server.close();
			this.server = undefined;
			this._port = 0;
		}
	}

	private async handleAskpass(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			const body = await this.readBody(req);
			const params = new URLSearchParams(body);
			const prompt = params.get('prompt') || 'Enter value:';

			this.logger.trace(`Askpass prompt: ${prompt}`);

			const isPassword = /password|passphrase/i.test(prompt);
			const isHostKey = /authenticity|fingerprint|yes\/no/i.test(prompt);

			let response: string | undefined;

			if (isHostKey) {
				// Host key verification prompt
				const result = await vscode.window.showWarningMessage(
					prompt,
					{ modal: true },
					'Yes',
					'No'
				);
				response = result === 'Yes' ? 'yes' : 'no';
			} else {
				response = await vscode.window.showInputBox({
					title: prompt,
					password: isPassword,
					ignoreFocusOut: true
				});
			}

			if (response === undefined) {
				// User cancelled - return empty to cause auth failure
				res.writeHead(200);
				res.end('');
			} else {
				res.writeHead(200);
				res.end(response);
			}
		} catch (e) {
			this.logger.error('Askpass handler error', e);
			res.writeHead(500);
			res.end('');
		}
	}

	private readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = '';
			req.on('data', (chunk: Buffer | string) => { body += chunk.toString(); });
			req.on('end', () => resolve(body));
			req.on('error', reject);
		});
	}
}
