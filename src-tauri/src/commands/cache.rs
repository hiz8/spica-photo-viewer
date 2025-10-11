use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize)]
pub struct CacheEntry {
    pub thumbnail: String,
    pub created: u64,
}

const CACHE_DURATION: u64 = 24 * 60 * 60; // 24 hours in seconds

fn get_cache_dir() -> Result<std::path::PathBuf, String> {
    let cache_dir = if cfg!(target_os = "windows") {
        // Windows: %APPDATA%\SpicaPhotoViewer\cache
        let app_data = std::env::var("APPDATA")
            .map_err(|_| "Failed to get APPDATA directory".to_string())?;
        Path::new(&app_data).join("SpicaPhotoViewer").join("cache")
    } else if cfg!(target_os = "macos") {
        // macOS: ~/Library/Caches/SpicaPhotoViewer
        let home = std::env::var("HOME")
            .map_err(|_| "Failed to get HOME directory".to_string())?;
        Path::new(&home)
            .join("Library")
            .join("Caches")
            .join("SpicaPhotoViewer")
    } else {
        // Linux: $XDG_CACHE_HOME/SpicaPhotoViewer or ~/.cache/SpicaPhotoViewer
        let cache_base = std::env::var("XDG_CACHE_HOME").unwrap_or_else(|_| {
            match std::env::var("HOME") {
                Ok(home) => format!("{}/.cache", home),
                Err(_) => {
                    eprintln!("Warning: HOME environment variable not set. Using /tmp/.cache as cache base.");
                    "/tmp/.cache".to_string()
                }
            }
        });
        Path::new(&cache_base).join("SpicaPhotoViewer")
    };

    if !cache_dir.exists() {
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create cache directory: {}", e))?;
    }

    Ok(cache_dir)
}

fn get_cache_key(path: &str, size: u32) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    size.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

#[tauri::command]
pub async fn get_cached_thumbnail(
    path: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    let cache_dir = get_cache_dir()?;
    let thumbnail_size = size.unwrap_or(30);
    let cache_key = get_cache_key(&path, thumbnail_size);
    let cache_file = cache_dir.join(format!("{}.json", cache_key));

    if !cache_file.exists() {
        return Ok(None);
    }

    let cache_content =
        fs::read_to_string(&cache_file).map_err(|e| format!("Failed to read cache file: {}", e))?;

    let cache_entry: CacheEntry = serde_json::from_str(&cache_content)
        .map_err(|e| format!("Failed to parse cache entry: {}", e))?;

    let current_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Check if cache is still valid
    if current_time - cache_entry.created > CACHE_DURATION {
        // Remove expired cache
        let _ = fs::remove_file(&cache_file);
        return Ok(None);
    }

    Ok(Some(cache_entry.thumbnail))
}

#[tauri::command]
pub async fn set_cached_thumbnail(
    path: String,
    thumbnail: String,
    size: Option<u32>,
) -> Result<(), String> {
    let cache_dir = get_cache_dir()?;
    let thumbnail_size = size.unwrap_or(30);
    let cache_key = get_cache_key(&path, thumbnail_size);
    let cache_file = cache_dir.join(format!("{}.json", cache_key));

    let current_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let cache_entry = CacheEntry {
        thumbnail,
        created: current_time,
    };

    let cache_content = serde_json::to_string(&cache_entry)
        .map_err(|e| format!("Failed to serialize cache entry: {}", e))?;

    fs::write(&cache_file, cache_content)
        .map_err(|e| format!("Failed to write cache file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn clear_old_cache() -> Result<(), String> {
    let cache_dir = match get_cache_dir() {
        Ok(dir) => dir,
        Err(_) => return Ok(()), // If cache dir doesn't exist, nothing to clean
    };

    if !cache_dir.exists() {
        return Ok(());
    }

    let current_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let entries =
        fs::read_dir(&cache_dir).map_err(|e| format!("Failed to read cache directory: {}", e))?;

    let mut removed_count = 0;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            match fs::read_to_string(&path) {
                Ok(content) => {
                    if let Ok(cache_entry) = serde_json::from_str::<CacheEntry>(&content) {
                        if current_time - cache_entry.created > CACHE_DURATION {
                            if fs::remove_file(&path).is_ok() {
                                removed_count += 1;
                            }
                        }
                    }
                }
                Err(_) => {
                    // Remove corrupted cache files
                    let _ = fs::remove_file(&path);
                    removed_count += 1;
                }
            }
        }
    }

    println!("Cleaned {} old cache entries", removed_count);
    Ok(())
}

#[tauri::command]
pub async fn get_cache_stats() -> Result<HashMap<String, u32>, String> {
    let cache_dir = match get_cache_dir() {
        Ok(dir) => dir,
        Err(_) => return Ok(HashMap::new()),
    };

    if !cache_dir.exists() {
        return Ok(HashMap::new());
    }

    let entries =
        fs::read_dir(&cache_dir).map_err(|e| format!("Failed to read cache directory: {}", e))?;

    let mut stats = HashMap::new();
    let mut total_files = 0;
    let mut valid_files = 0;

    let current_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                total_files += 1;

                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(cache_entry) = serde_json::from_str::<CacheEntry>(&content) {
                        if current_time - cache_entry.created <= CACHE_DURATION {
                            valid_files += 1;
                        }
                    }
                }
            }
        }
    }

    stats.insert("total_files".to_string(), total_files);
    stats.insert("valid_files".to_string(), valid_files);

    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[tokio::test]
    async fn test_get_cached_thumbnail_returns_ok() {
        // Test that the function doesn't panic and returns Ok result
        let result = get_cached_thumbnail("/test/nonexistent.jpg".to_string(), Some(30)).await;
        assert!(result.is_ok());
        // Result can be None (no cache) or Some(data) depending on environment
    }

    #[tokio::test]
    async fn test_set_cached_thumbnail_returns_ok() {
        // Test that setting cache doesn't panic and returns Ok result
        let result = set_cached_thumbnail(
            "/test/unique_001.jpg".to_string(),
            "test_data".to_string(),
            Some(30),
        )
        .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_cached_thumbnail_with_default_size() {
        // Test with None size (default)
        let result = get_cached_thumbnail("/test/default_size.jpg".to_string(), None).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_set_cached_thumbnail_with_default_size() {
        // Test setting with None size (default)
        let result = set_cached_thumbnail(
            "/test/default_size.jpg".to_string(),
            "default_data".to_string(),
            None,
        )
        .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_clear_old_cache_returns_ok() {
        // Test that cache clearing doesn't panic and returns Ok result
        let result = clear_old_cache().await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_cache_stats_returns_ok() {
        // Test that cache stats retrieval doesn't panic and returns Ok result
        let result = get_cache_stats().await;
        assert!(result.is_ok());

        let stats = result.unwrap();
        // Should contain the expected keys
        assert!(stats.contains_key("total_files"));
        assert!(stats.contains_key("valid_files"));
    }

    #[test]
    fn test_get_cache_key_consistency() {
        // Test that cache key generation is consistent
        let path = "/test/image.jpg";
        let size = 30;

        let key1 = get_cache_key(path, size);
        let key2 = get_cache_key(path, size);

        assert_eq!(key1, key2); // Same inputs should produce same key

        let key3 = get_cache_key(path, 50);
        assert_ne!(key1, key3); // Different size should produce different key

        let key4 = get_cache_key("/test/other.jpg", size);
        assert_ne!(key1, key4); // Different path should produce different key
    }

    #[test]
    fn test_get_cache_dir_returns_ok() {
        // Test that cache directory creation doesn't panic
        let result = get_cache_dir();
        assert!(result.is_ok());

        let cache_dir = result.unwrap();
        assert!(cache_dir.to_string_lossy().contains("SpicaPhotoViewer"));
        assert!(cache_dir.to_string_lossy().contains("cache"));
    }

    #[test]
    fn test_cache_entry_serialization() {
        // Test that CacheEntry can be serialized and deserialized
        let entry = CacheEntry {
            thumbnail: "test_thumbnail_data".to_string(),
            created: 1234567890,
        };

        let serialized = serde_json::to_string(&entry);
        assert!(serialized.is_ok());

        let deserialized: Result<CacheEntry, _> = serde_json::from_str(&serialized.unwrap());
        assert!(deserialized.is_ok());

        let deserialized_entry = deserialized.unwrap();
        assert_eq!(entry.thumbnail, deserialized_entry.thumbnail);
        assert_eq!(entry.created, deserialized_entry.created);
    }
}
