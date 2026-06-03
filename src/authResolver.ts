import * as stream from 'stream';
import * as vscode from 'vscode';
import Log from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConfiguration from './ssh/sshConfig';
import { installCodeServer, ServerInstallError, findServerInstallPath } from './serverSetup';
import { ISSHSession } from './ssh/sshSession';
import { SSHCli } from './ssh/sshCli';
import { AskpassServer } from './ssh/askpassServer';
import * as os from 'os';
import { isNullable } from '@zokugun/is-it-type';

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

/**
 * Build the VS Code remote authority string for an SSH host.
 *
 * @param host - The hostname or SSH config alias
 * @returns The authority string in the form `ssh-remote+<host>`
 */
export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}


/**
 * VS Code remote authority resolver for SSH connections.
 *
 * Handles the full lifecycle of an SSH remote session:
 * 1. Parses the remote authority and SSH config
 * 2. Establishes an SSH connection via the OS `ssh` binary
 * 3. Installs/locates the VS Code server on the remote host
 * 4. Provides a managed message-passing channel for VS Code communication
 * 5. Supports automatic reconnection on session failure
 */
export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private sshCliSession: SSHCli | undefined;
    private askpassServer: AskpassServer | undefined;

    private labelFormatterDisposable: vscode.Disposable | undefined;

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log
    ) {
    }

    /**
     * Resolve a remote SSH authority.
     *
     * Called by VS Code when opening a remote SSH window or when reconnecting.
     * On reconnection attempts (`context.resolveAttempt > 1`), stale connections
     * from the previous resolve are cleaned up before retrying.
     *
     * @param authority - The remote authority string (`ssh-remote+<host>`)
     * @param context - Resolver context including the current attempt number
     * @returns A resolver result with a managed connection to the remote VS Code server
     * @throws {vscode.RemoteAuthorityResolverError} On permanent or retryable failures
     */
    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attempt #${context.resolveAttempt})`);

        // On reconnection attempts, clean up stale connections from the previous resolve
        if (context.resolveAttempt > 1) {
            this.logger.info(`Reconnection attempt #${context.resolveAttempt}: cleaning up previous SSH connections`);
            this.cleanupPreviousConnections();
        }

        const sshDest = SSHDestination.parseEncoded(dest);

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const enableAgentForwarding = remoteSSHconfig.get<boolean>('enableAgentForwarding', true)!;
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate');
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remotePlatformMap = remoteSSHconfig.get<Record<string, string>>('remotePlatform', {});
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;
        const serverInstallPathMap = remoteSSHconfig.get<Record<string, string>>('serverInstallPath', {});
        const sshPath = remoteSSHconfig.get<string>('path', '');

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const sshconfig = await SSHConfiguration.loadFromFS();
                const sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                const sshHostName = sshHostConfig['HostName'] ? sshHostConfig['HostName'].replace('%h', sshDest.hostname) : sshDest.hostname;
                const sshUser = sshHostConfig['User'] || sshDest.user || os.userInfo().username || ''; // https://github.com/openssh/openssh-portable/blob/5ec5504f1d328d5bfa64280cd617c3efec4f78f3/sshconnect.c#L1561-L1562
                const sshPort = sshHostConfig['Port'] ? parseInt(sshHostConfig['Port'], 10) : (sshDest.port || 22);
                const session: ISSHSession = await this.connectWithSSHCli(sshDest, sshHostName, sshUser, sshPort, sshPath || undefined);

                const envVariables: Record<string, string | null> = {};
                const agentForward = enableAgentForwarding && (sshHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                if (agentForward) {
                    envVariables['SSH_AUTH_SOCK'] = null;
                }

                // Find the custom install path for this hostname (supports wildcards)
                const customInstallPath = findServerInstallPath(sshDest.hostname, serverInstallPathMap);

                this.logger.info(`Finding/installing code server (attempt #${context.resolveAttempt})...`);
                const installResult = await installCodeServer(session, serverDownloadUrlTemplate, defaultExtensions, Object.keys(envVariables), remotePlatformMap[sshDest.hostname], remoteServerListenOnSocket, customInstallPath, this.logger);
                this.logger.info(`Code server ready: listeningOn=${typeof installResult.listeningOn === 'number' ? installResult.listeningOn : '(socket)'} (attempt #${context.resolveAttempt})`);

                for (const key of Object.keys(envVariables)) {
                    if (!isNullable(installResult[key])) {
                        envVariables[key] = String(installResult[key]);
                    }
                }

                // Update terminal env variables
                this.context.environmentVariableCollection.persistent = false;
                for (const [key, value] of Object.entries(envVariables)) {
                    if (value) {
                        this.context.environmentVariableCollection.replace(key, value);
                    }
                }

                // Enable ports view
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority: `${REMOTE_SSH_AUTHORITY}+*`,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: `SSH: ${sshDest.hostname}` + (sshDest.port && sshDest.port !== 22 ? `:${sshDest.port}` : '')
                    }
                });

                // Use ManagedResolvedAuthority to avoid creating local TCP servers,
                // which triggers Windows firewall dialogs on unsigned binaries.
                const currentSession = session;
                const listeningOn = installResult.listeningOn;
                const resolvedResult: vscode.ResolverResult = new vscode.ManagedResolvedAuthority(
                    async () => {
                        // Check if the SSH session is still alive before opening a channel.
                        // If dead (e.g., network outage killed ControlMaster), re-establish
                        // the connection transparently. VSCode's reconnection loop calls
                        // makeConnection() on each retry attempt, so we get a chance to
                        // recover here without triggering a permanent failure.
                        if (!currentSession.isAlive()) {
                            this.logger.info('SSH session is dead, attempting to reconnect...');
                            try {
                                await currentSession.reconnect();
                                this.logger.info('SSH session reconnected successfully in makeConnection()');
                            } catch (reconnectErr) {
                                this.logger.error('SSH reconnection failed in makeConnection()', reconnectErr);
                                // Throw with network error code so VSCode's reconnection loop
                                // recognizes this as retryable (ECONNRESET + syscall 'connect')
                                const err = new Error(`SSH reconnection failed: ${reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)}`);
                                (err as unknown as Record<string, unknown>).code = 'ECONNRESET';
                                (err as unknown as Record<string, unknown>).syscall = 'connect';
                                throw err;
                            }
                        }

                        let channel: stream.Duplex;
                        try {
                            if (typeof listeningOn === 'number') {
                                channel = await currentSession.forwardOut('127.0.0.1', 0, '127.0.0.1', listeningOn);
                            } else {
                                channel = await currentSession.forwardOutStreamLocal(listeningOn);
                            }
                        } catch (forwardErr) {
                            this.logger.error('Failed to open SSH channel', forwardErr);
                            // If forwardOut fails even after isAlive() returned true,
                            // the session might have died between the check and the forward.
                            // Throw with retryable error code.
                            const err = new Error(`SSH channel open failed: ${forwardErr instanceof Error ? forwardErr.message : String(forwardErr)}`);
                            (err as unknown as Record<string, unknown>).code = 'ECONNRESET';
                            (err as unknown as Record<string, unknown>).syscall = 'connect';
                            throw err;
                        }
                        return this.createManagedMessagePassingFromStream(channel);
                    },
                    installResult.connectionToken
                );
                resolvedResult.extensionHostEnv = envVariables;
                return resolvedResult;
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority (attempt #${context.resolveAttempt})`, e);

                // Initial connection
                if (context.resolveAttempt === 1) {
                    this.logger.show();

                    const closeRemote = 'Close Remote';
                    const retry = 'Retry';
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to "${sshDest.hostname}"`, { modal: true }, closeRemote, retry);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }

                    // On initial connection, ServerInstallError is permanent (e.g. unsupported platform)
                    if (e instanceof ServerInstallError || !(e instanceof Error)) {
                        throw vscode.RemoteAuthorityResolverError.NotAvailable(e instanceof Error ? e.message : String(e));
                    }
                } else {
                    this.logger.info(`Reconnection attempt #${context.resolveAttempt} failed, will throw TemporarilyNotAvailable to trigger retry`);
                }

                // On reconnection attempts, all errors are retryable to allow
                // VSCode's reconnection loop to keep trying (grace time: 3 hours)
                const message = e instanceof Error ? e.message : String(e);
                throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(message);
            }
        });
    }

    /**
     * Wrap a Node.js Duplex stream as a VS Code ManagedMessagePassing instance.
     *
     * Bridges the SSH channel's stream-based API to VS Code's event-driven
     * message passing interface used by ManagedResolvedAuthority.
     *
     * @param channel - The duplex stream (from SSH forwarding)
     * @returns A ManagedMessagePassing adapter for VS Code
     */
    private createManagedMessagePassingFromStream(channel: stream.Duplex): vscode.ManagedMessagePassing {
        const messageEmitter = new vscode.EventEmitter<Uint8Array>();
        const closeEmitter = new vscode.EventEmitter<Error | undefined>();
        const endEmitter = new vscode.EventEmitter<void>();

        channel.on('data', (data: Buffer | string) => {
            messageEmitter.fire(Uint8Array.from(Buffer.isBuffer(data) ? data : Buffer.from(data)));
        });

        channel.on('close', () => {
            closeEmitter.fire(undefined);
            messageEmitter.dispose();
            closeEmitter.dispose();
            endEmitter.dispose();
        });

        channel.on('error', (err: Error) => {
            closeEmitter.fire(err);
        });

        channel.on('end', () => {
            endEmitter.fire();
        });

        return {
            onDidReceiveMessage: messageEmitter.event,
            onDidClose: closeEmitter.event,
            onDidEnd: endEmitter.event,
            send: (data: Uint8Array) => {
                channel.write(Buffer.from(data));
            },
            end: () => {
                channel.end();
            }
        };
    }

    /**
     * Connect using the OS ssh binary.
     *
     * On macOS/Linux: uses ControlMaster for connection multiplexing.
     * On Windows: verifies connectivity with a direct ssh command.
     *
     * Passes `sshDest.hostname` as `hostAlias` to {@link SSHCli} so that the
     * original SSH config alias is preserved as the SSH target. This ensures
     * `~/.ssh/config` Host blocks (ProxyJump, IdentityFile, ServerAliveInterval,
     * etc.) are correctly matched rather than bypassed by the resolved IP.
     *
     * @param sshDest - Parsed SSH destination (hostname may be an alias from `~/.ssh/config`)
     * @param sshHostName - Resolved IP/hostname from the SSH config HostName directive
     * @param sshUser - Resolved username (from SSH config, destination, or OS default)
     * @param sshPort - Resolved port number (from SSH config or destination, defaults to 22)
     * @param sshPath - Optional custom path to the ssh binary
     * @returns An active SSH session
     */
    private async connectWithSSHCli(sshDest: SSHDestination, sshHostName: string, sshUser: string, sshPort: number, sshPath?: string): Promise<ISSHSession> {
        this.logger.info(`Connecting with SSH CLI to ${sshHostName}:${sshPort}`);

        // Start askpass server
        if (!this.askpassServer) {
            this.askpassServer = new AskpassServer(this.logger);
            await this.askpassServer.start();
        }

        const sshCli = new SSHCli(
            {
                host: sshHostName,
                port: sshPort,
                username: sshUser,
                hostAlias: sshDest.hostname,
                sshPath,
            },
            this.logger,
            this.askpassServer
        );

        await sshCli.connect();
        this.sshCliSession = sshCli;
        return sshCli;
    }

    /**
     * Clean up previous SSH connections before establishing new ones on reconnection.
     * Without this, dead SSH connections and proxy processes would leak resources
     * and potentially interfere with the new connection establishment.
     */
    private cleanupPreviousConnections(): void {
        // Close SSH CLI session if active
        if (this.sshCliSession) {
            try {
                this.sshCliSession.close();
            } catch (e) {
                this.logger.trace(`Error closing SSH CLI session during cleanup: ${e}`);
            }
            this.sshCliSession = undefined;
        }
    }

    /**
     * Dispose of all resources held by this resolver.
     *
     * Closes the active SSH session, stops the askpass server, and
     * unregisters the resource label formatter.
     */
    dispose() {
        // Close SSH CLI session
        if (this.sshCliSession) {
            this.sshCliSession.close();
            this.sshCliSession = undefined;
        }

        // Close askpass server
        if (this.askpassServer) {
            this.askpassServer.stop();
            this.askpassServer = undefined;
        }

        this.labelFormatterDisposable?.dispose();
    }
}
