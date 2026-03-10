import type { BriefResult } from "@shared/schema";

export interface IStorage {
  storeJob(jobId: string, briefs: BriefResult[]): void;
  getJob(jobId: string): BriefResult[] | undefined;
  deleteJob(jobId: string): void;
}

export class MemStorage implements IStorage {
  private jobs: Map<string, BriefResult[]>;

  constructor() {
    this.jobs = new Map();
  }

  storeJob(jobId: string, briefs: BriefResult[]): void {
    this.jobs.set(jobId, briefs);
  }

  getJob(jobId: string): BriefResult[] | undefined {
    return this.jobs.get(jobId);
  }

  deleteJob(jobId: string): void {
    this.jobs.delete(jobId);
  }
}

export const storage = new MemStorage();
