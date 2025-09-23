import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export const useCacheManager = () => {
  useEffect(() => {
    const initializeCache = async () => {
      try {
        // Clean up old cache entries on startup
        await invoke('clear_old_cache');
        console.log('Cache cleanup completed');

        // Optional: Log cache statistics
        const stats = await invoke<{ [key: string]: number }>('get_cache_stats');
        console.log('Cache stats:', stats);
      } catch (error) {
        console.warn('Failed to initialize cache:', error);
      }
    };

    initializeCache();
  }, []);

  const clearCache = async () => {
    try {
      await invoke('clear_old_cache');
      console.log('Manual cache cleanup completed');
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  };

  const getCacheStats = async () => {
    try {
      const stats = await invoke<{ [key: string]: number }>('get_cache_stats');
      return stats;
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return {};
    }
  };

  return {
    clearCache,
    getCacheStats,
  };
};