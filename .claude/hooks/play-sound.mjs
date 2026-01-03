#!/usr/bin/env node

import { exec } from 'node:child_process';
import os from 'node:os';

const SOUND_CONFIGS = {
  darwin: {
    command: 'afplay',
    sounds: {
      default: '/System/Library/Sounds/Funk.aiff',
      notification: '/System/Library/Sounds/Blow.aiff',
      done: '/System/Library/Sounds/Frog.aiff',
    },
  },
  linux: {
    command: 'paplay || aplay || play',
    sounds: {
      default: '/usr/share/sounds/freedesktop/stereo/complete.oga',
      notification: '/usr/share/sounds/freedesktop/stereo/message.oga',
      done: '/usr/share/sounds/freedesktop/stereo/bell.oga',
    },
  },
  win32: {
    sounds: {
      default: 'C:\\Windows\\Media\\tada.wav',
      notification: 'C:\\Windows\\Media\\Windows Notify.wav',
      done: 'C:\\Windows\\Media\\Windows Ding.wav',
    },
  },
};

function debugLog(message) {
  if (process.env.DEBUG) {
    console.error(message);
  }
}

function getSoundCommand(type = 'default') {
  const platform = os.platform();
  const config = SOUND_CONFIGS[platform];

  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const soundFile = config.sounds[type] || config.sounds.default;

  if (platform === 'win32') {
    return `powershell -c "(New-Object Media.SoundPlayer '${soundFile}').PlaySync()"`;
  }

  return `${config.command} "${soundFile}"`;
}

function playSound(type) {
  try {
    const command = getSoundCommand(type);
    exec(command, (error, _, stderr) => {
      if (error) {
        debugLog(`Sound playback failed: ${error.message}`);
      } else if (stderr) {
        debugLog(`Sound playback warning: ${stderr}`);
      }
    });
  } catch (error) {
    debugLog(`Sound error: ${error.message}`);
  }
}

playSound(process.argv[2]);
