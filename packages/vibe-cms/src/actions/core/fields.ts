import { z } from "zod";

/** Input fields several groups of actions share. */

export const type = z.string().describe("Content type, e.g. \"post\". `schema.list` lists them");
export const limit = z.number().int().min(1).max(200).optional();
export const offset = z.number().int().min(0).optional();
export const folder = z.string().describe("Folder path like posts/covers");
