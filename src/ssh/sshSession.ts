import * as stream from 'stream';

/**
 * Common interface for SSH session implementations.
 * SSHCli (OS ssh binary) implements this interface.
 */
export interface ISSHSession {
	/**
	 * Execute a command on the remote host and collect all output.
	 */
	exec(cmd: string): Promise<{ stdout: string; stderr: string }>;

	/**
	 * Execute a command on the remote host and resolve early when tester returns true.
	 */
	execPartial(cmd: string, tester: (stdout: string, stderr: string) => boolean, params?: Array<string>): Promise<{ stdout: string; stderr: string }>;

	/**
	 * Forward a TCP connection to a remote host:port, returning a bidirectional stream.
	 */
	forwardOut(srcIP: string, srcPort: number, destIP: string, destPort: number): Promise<stream.Duplex>;

	/**
	 * Forward a connection to a remote Unix domain socket, returning a bidirectional stream.
	 */
	forwardOutStreamLocal(socketPath: string): Promise<stream.Duplex>;

	/**
	 * Close the SSH session and clean up resources.
	 */
	close(): Promise<void>;
}
