#!/usr/bin/env node
// dropbin — `db`. Everything lives in ../src; this is only the entry point.
import { main } from "../src/main.js";
main(process.argv.slice(2));
