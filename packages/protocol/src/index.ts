/**
 * The contracts between Vireo's three parts. Types only: nothing here runs,
 * so each side compiles against the same shapes without sharing code.
 *
 *   node.ts    what a node's HTTP API returns (the app reads it)
 *   events.ts  live updates a node streams to the app
 *   cloud.ts   the cloud API: accounts, nodes, linking, access tokens
 *   relay.ts   frames between the cloud and a node over the relay socket
 */
export type * from "./cloud.js";
export type * from "./events.js";
export type * from "./node.js";
export type * from "./relay.js";
