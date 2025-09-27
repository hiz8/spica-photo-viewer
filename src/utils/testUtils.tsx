import React from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { ImageData, ImageInfo } from '../types';

// Test utilities for common test scenarios

// Sample test data
export const mockImageData: ImageData = {
  path: '/test/image.jpg',
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  width: 800,
  height: 600,
  format: 'jpeg',
};

export const mockImageInfo: ImageInfo = {
  path: '/test/image.jpg',
  name: 'image.jpg',
  size: 1024,
  modified: Date.now(),
};

export const mockImageList: ImageInfo[] = [
  {
    path: '/test/image1.jpg',
    name: 'image1.jpg',
    size: 1024,
    modified: Date.now() - 3000,
  },
  {
    path: '/test/image2.png',
    name: 'image2.png',
    size: 2048,
    modified: Date.now() - 2000,
  },
  {
    path: '/test/image3.gif',
    name: 'image3.gif',
    size: 512,
    modified: Date.now() - 1000,
  },
];

// Custom render function that can include providers
export const renderWithProviders = (
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => {
  return render(ui, options);
};

// Mock window resize helper
export const mockWindowResize = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    writable: true,
    configurable: true,
    value: height,
  });
  window.dispatchEvent(new Event('resize'));
};

// Mock mouse event helpers
export const createMouseEvent = (
  type: string,
  clientX: number = 0,
  clientY: number = 0,
  button: number = 0
): MouseEvent => {
  return new MouseEvent(type, {
    clientX,
    clientY,
    button,
    bubbles: true,
    cancelable: true,
  });
};

// Mock wheel event helper
export const createWheelEvent = (
  deltaY: number,
  clientX: number = 0,
  clientY: number = 0
): WheelEvent => {
  return new WheelEvent('wheel', {
    deltaY,
    clientX,
    clientY,
    bubbles: true,
    cancelable: true,
  });
};

// Mock keyboard event helper
export const createKeyboardEvent = (
  key: string,
  ctrlKey: boolean = false
): KeyboardEvent => {
  return new KeyboardEvent('keydown', {
    key,
    ctrlKey,
    bubbles: true,
    cancelable: true,
  });
};