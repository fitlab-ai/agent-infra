#!/usr/bin/env node
import fs from "node:fs";

function locateGceOffsets(data) {
  const offsets = [];
  let index = 0;

  while (index < data.length - 7) {
    if (data[index] === 0x21 && data[index + 1] === 0xF9 && data[index + 2] === 0x04) {
      offsets.push(index);
      index += 8;
    } else {
      index += 1;
    }
  }

  return offsets;
}

function calculateDelays(frameCount, targetSeconds) {
  const targetCs = Math.max(frameCount * 2, Math.round(targetSeconds * 100));
  const baseDelay = Math.floor(targetCs / frameCount);
  const extraFrames = targetCs % frameCount;

  return Array.from({ length: frameCount }, (_, index) => (
    index < extraFrames ? baseDelay + 1 : baseDelay
  ));
}

function normalize(filePath, targetSeconds) {
  const data = Buffer.from(fs.readFileSync(filePath));
  const gceOffsets = locateGceOffsets(data);

  if (gceOffsets.length === 0) {
    return;
  }

  const delaysCs = calculateDelays(gceOffsets.length, targetSeconds);

  for (const [index, offset] of gceOffsets.entries()) {
    data.writeUInt16LE(delaysCs[index], offset + 4);
  }

  fs.writeFileSync(filePath, data);

  const totalCs = delaysCs.reduce((sum, delay) => sum + delay, 0);
  const actualSeconds = totalCs / 100;
  const minDelay = Math.min(...delaysCs);
  const maxDelay = Math.max(...delaysCs);
  const delaySummary = minDelay === maxDelay
    ? `${minDelay * 10}ms`
    : `${minDelay * 10}-${maxDelay * 10}ms`;

  process.stdout.write(
    `Normalized: ${gceOffsets.length} frames, ${delaySummary}, total ${actualSeconds.toFixed(1)}s\n`
  );
}

if (process.argv.length !== 4) {
  process.stderr.write(`Usage: ${process.argv[1]} <gif-path> <target-seconds>\n`);
  process.exit(1);
}

normalize(process.argv[2], Number(process.argv[3]));
