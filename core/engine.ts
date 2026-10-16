import * as fs from 'fs';
import * as path from 'path';
import { LoopConfig, BatchItem, Checkpoint, WorkerFunction, WorkerContext } from './types.js';
import { Logger } from './logger.js';
import { AgentBridgeError } from './llm.js';

export class LoopEngine<T = any> {
    // ponytail: fixed bounds for 100k-scale — per-item log cap (checkpoint stays O(items), not O(items × logs)).
    private static readonly MAX_ITEM_LOGS = 20;
    private static readonly STATE_VERSION = 1;
    private config: LoopConfig;
    private logger: Logger;
    private checkpoint: Checkpoint<T>;

    constructor(config: LoopConfig) {
        this.config = {
            concurrency: 1,
            maxRetries: 3,
            ...config,
        };

        // Initialize logger
        const logDir = path.dirname(this.config.checkpointPath);
        const jobName = path.basename(this.config.checkpointPath, '.json');
        this.logger = new Logger(logDir, jobName);

        this.checkpoint = this.loadCheckpoint();
    }

    private loadCheckpoint(): Checkpoint<T> {
        if (fs.existsSync(this.config.checkpointPath)) {
            this.logger.log('Resuming from checkpoint...');
            const loaded = JSON.parse(fs.readFileSync(this.config.checkpointPath, 'utf-8')) as Checkpoint<T>;
            // Backward compat: checkpoints written before stateVersion exist load as version 0.
            if (loaded.stateVersion === undefined) loaded.stateVersion = 0;
            this.checkpoint = loaded;
            this.recount();
            return this.checkpoint;
        }

        this.logger.log('Starting new job...');
        // Load input data
        let inputData = [];
        if (this.config.inputData) {
            inputData = this.config.inputData;
        } else if (this.config.inputPath) {
            inputData = JSON.parse(fs.readFileSync(this.config.inputPath, 'utf-8'));
        }

        return {
            jobId: `job-${Date.now()}`,
            startTime: new Date().toISOString(),
            stateVersion: LoopEngine.STATE_VERSION,
            items: inputData.map((item: T, index: number) => ({
                id: `item-${index}`,
                data: item,
                status: 'pending',
                attempts: 0,
                logs: []
            })),
            completedCount: 0,
            failedCount: 0
        };
    }

    /** Recompute counters from item states — the single source of truth, so a
     *  resume after a crash can never double-count (persisted counters are ignored). */
    private recount(): void {
        const maxRetries = this.config.maxRetries || 3;
        this.checkpoint.completedCount = this.checkpoint.items.filter(i => i.status === 'completed').length;
        this.checkpoint.failedCount = this.checkpoint.items.filter(i => i.status === 'failed' && i.attempts >= maxRetries).length;
    }

    private saveCheckpoint() {
        // Atomic write: tmp + rename, so a crash mid-write never leaves partial JSON.
        const tmpPath = `${this.config.checkpointPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(this.checkpoint, null, 2));
        fs.renameSync(tmpPath, this.config.checkpointPath);
    }

    // Drain API choice: listAwaiting() + resolveAwaiting(id, result) instead of a
    // single drainAgentQueue(handler), so a human/agent can inspect parked prompts
    // first and resolve items one by one (with a result => completed, without => requeue).
    /** Parked items waiting on the agent, with their pending prompts. */
    listAwaiting(): BatchItem<T>[] {
        return this.checkpoint.items.filter(i => i.status === 'awaiting_agent');
    }

    /** Resolve one parked item. With a result it completes; without, it requeues for the next run(). Returns false when the id is unknown or not parked. */
    resolveAwaiting(id: string, result?: unknown): boolean {
        const item = this.checkpoint.items.find(i => i.id === id && i.status === 'awaiting_agent');
        if (!item) return false;
        if (result !== undefined) {
            item.status = 'completed';
            item.output = result;
            delete item.pendingPrompt;
        } else {
            item.status = 'pending';
            delete item.pendingPrompt;
        }
        this.recount();
        this.saveCheckpoint();
        return true;
    }

    async run(worker: WorkerFunction<T>) {
        this.logger.log(`Starting execution with ${this.checkpoint.items.length} items. Concurrency: ${this.config.concurrency || 1}`);

        const pendingItems = this.checkpoint.items.filter(item => {
            if (item.status === 'completed') return false;
            if (item.status === 'awaiting_agent') return false; // Already paused for agent
            if (item.status === 'failed' && (item.attempts >= (this.config.maxRetries || 3))) return false;
            return true;
        });

        const concurrency = this.config.concurrency || 1;
        const activePromises: Promise<void>[] = [];
        const total = this.checkpoint.items.length;
        const every = this.config.progressEvery || 100;
        let settled = 0;
        const report = () => {
            settled++;
            if (this.config.onProgress && (settled % every === 0 || settled === pendingItems.length)) {
                this.config.onProgress(settled, total);
            }
        };

        for (const item of pendingItems) {
            // Wait if we reached concurrency limit
            if (activePromises.length >= concurrency) {
                await Promise.race(activePromises);
            }

            const promise = this.processItem(item, worker).then(() => {
                report();
                // Remove self from active promises
                const index = activePromises.indexOf(promise);
                if (index > -1) activePromises.splice(index, 1);
            });

            activePromises.push(promise);
        }

        // Wait for remaining items
        await Promise.all(activePromises);

        this.logger.log('Job finished.');
        const awaiting = this.checkpoint.items.filter(i => i.status === 'awaiting_agent').length;
        const totalItems = this.checkpoint.items.length;
        const completed = this.checkpoint.completedCount;

        this.logger.log(`Completed: ${completed}, Failed: ${this.checkpoint.failedCount}, Awaiting Agent: ${awaiting}`);

        // CLEANUP SIGNALING
        if (completed === totalItems && totalItems > 0) {
            this.logger.log('✅ All items completed successfully.');
            this.checkpoint.cleanupReady = true;
            this.checkpoint.cleanupFiles = [
                this.config.inputPath,
                this.config.checkpointPath,
                path.join(path.dirname(this.config.checkpointPath), `${path.basename(this.config.checkpointPath, '.json')}.log`)
            ].filter(Boolean) as string[];

            this.logger.log(`🧹 Cleanup ready for: ${this.checkpoint.cleanupFiles.join(', ')}`);
            this.saveCheckpoint();
        }

        if (awaiting > 0) {
            this.logger.log(`📢 ${awaiting} items are waiting for AI thinking. I (the Agent) will fulfill them now.`);
        }
    }

    private async processItem(item: BatchItem<T>, worker: WorkerFunction<T>) {
        this.logger.log(`Processing item ${item.id}... (Attempt ${item.attempts + 1})`);

        item.status = 'processing';
        item.attempts++;
        this.saveCheckpoint();

        const itemLogger: WorkerContext = {
            log: (msg: string) => {
                this.logger.log(`[${item.id}] ${msg}`);
                item.logs = item.logs || [];
                item.logs.push(msg);
                // 100k-scale bound: keep the newest entries, count the dropped oldest.
                if (item.logs.length > LoopEngine.MAX_ITEM_LOGS) {
                    item.logs.shift();
                    item.logsDropped = (item.logsDropped || 0) + 1;
                }
            }
        };

        try {
            // Create a promise that rejects after timeout
            let workerPromise = worker(item.data, itemLogger);

            if (this.config.itemTimeoutMs && this.config.itemTimeoutMs > 0) {
                const timeoutPromise = new Promise<any>((_, reject) => {
                    setTimeout(() => reject(new Error(`Operation timed out after ${this.config.itemTimeoutMs}ms`)), this.config.itemTimeoutMs);
                });
                workerPromise = Promise.race([workerPromise, timeoutPromise]);
            }

            const result = await workerPromise;

            item.status = 'completed';
            item.output = result;
            this.checkpoint.completedCount++;
            this.logger.log(`Item ${item.id} COMPLETED.`);

        } catch (error: any) {
            if (error instanceof AgentBridgeError) {
                this.logger.log(`Item ${item.id} transitioned to AWAITING_AGENT (recorded brain request).`);
                item.status = 'awaiting_agent';
                item.pendingPrompt = error.messages;
                // Don't count as a failed attempt since it just needs the agent to step in
                item.attempts--;
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.logger.error(`Item ${item.id} FAILED: ${errorMessage}`);

                item.lastError = errorMessage;
                item.status = 'failed';
                // If we haven't hit max retries, it stays 'failed' but might be picked up next run 
                // or we could implementing immediate retry logic here.
                // For now, we count it as failed for this run.

                if (item.attempts >= (this.config.maxRetries || 3)) {
                    this.checkpoint.failedCount++;
                }
            }
        } finally {
            this.saveCheckpoint();
        }
    }
}
