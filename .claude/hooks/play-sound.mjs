#!/usr/bin/env node

import { execSync } from 'node:child_process';
import os from 'node:os';

const VALID_SOUND_TYPES = ['default', 'notification', 'done'];

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
    commands: ['paplay', 'aplay', 'play'],
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

function validateSoundType(type) {
  if (!type || !VALID_SOUND_TYPES.includes(type)) {
    return 'default';
  }
  return type;
}

function getSoundCommand(type) {
  const platform = os.platform();
  const config = SOUND_CONFIGS[platform];

  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const validType = validateSoundType(type);
  const soundFile = config.sounds[validType];

  if (platform === 'win32') {
    return `powershell -c "(New-Object Media.SoundPlayer '${soundFile}').PlaySync()"`;
  }

  if (platform === 'linux') {
    const fallbackCommands = config.commands
      .map((cmd) => `${cmd} "${soundFile}"`)
      .join(' || ');
    return fallbackCommands;
  }

  return `${config.command} "${soundFile}"`;
}

function playSound(type) {
  try {
    const command = getSoundCommand(type);
    execSync(command, { stdio: 'ignore' });
  } catch (error) {
    debugLog(`Sound error: ${error.message}`);
  }
}

playSound(process.argv[2]);
