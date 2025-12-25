/**
 * HFT CPU Mapper - Utility Functions
 * Reusable helper functions for parsing, formatting, and data manipulation
 */

const Utils = {
    /**
     * Parse a CPU range string like "0-31, 64-95" into an array of numbers
     * @param {string} str - Range string to parse
     * @returns {number[]} Array of CPU numbers
     */
    parseRange(str) {
        const result = [];
        if (!str) return result;
        
        str.toString().split(',').forEach(part => {
            part = part.trim();
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(x => parseInt(x.trim()));
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = start; i <= end; i++) {
                        result.push(i);
                    }
                }
            } else {
                const val = parseInt(part);
                if (!isNaN(val)) result.push(val);
            }
        });
        
        return result;
    },

    /**
     * Format an array of CPU numbers into a compact range string
     * @param {number[]} cores - Array of CPU numbers
     * @returns {string} Compressed range string like "0-31, 64-95"
     */
    formatCoreRange(cores) {
        if (cores.length === 0) return '';
        
        const sorted = [...cores].sort((a, b) => a - b);
        const ranges = [];
        let start = sorted[0], end = sorted[0];

        for (let i = 1; i <= sorted.length; i++) {
            if (i < sorted.length && sorted[i] === end + 1) {
                end = sorted[i];
            } else {
                ranges.push(start === end ? `${start}` : `${start}-${end}`);
                if (i < sorted.length) {
                    start = sorted[i];
                    end = sorted[i];
                }
            }
        }
        
        return ranges.join(',');
    },

    /**
     * Convert an array of CPU numbers to a hexadecimal bitmask
     * @param {number[]} cores - Array of CPU numbers
     * @returns {string} Hexadecimal bitmask like "0x0000FFFF"
     */
    coresToMask(cores) {
        let mask = BigInt(0);
        cores.forEach(c => {
            mask |= BigInt(1) << BigInt(c);
        });
        return '0x' + mask.toString(16).toUpperCase();
    },

    /**
     * Deep clone an object or array
     * @param {any} obj - Object to clone
     * @returns {any} Deep cloned copy
     */
    deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (obj instanceof Date) return new Date(obj.getTime());
        if (obj instanceof Array) return obj.map(item => this.deepClone(item));
        if (obj instanceof Set) return new Set(Array.from(obj).map(item => this.deepClone(item)));
        
        const clonedObj = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                clonedObj[key] = this.deepClone(obj[key]);
            }
        }
        return clonedObj;
    },

    /**
     * Check if a value is a valid number
     * @param {any} value - Value to check
     * @returns {boolean} True if valid number
     */
    isNumber(value) {
        return typeof value === 'number' && !isNaN(value) && isFinite(value);
    },

    /**
     * Safe parse integer with fallback
     * @param {string} str - String to parse
     * @param {number} fallback - Default value if parse fails
     * @returns {number} Parsed integer or fallback
     */
    parseInt(str, fallback = 0) {
        const val = parseInt(str, 10);
        return isNaN(val) ? fallback : val;
    },

    /**
     * Safe parse float with fallback
     * @param {string} str - String to parse
     * @param {number} fallback - Default value if parse fails
     * @returns {number} Parsed float or fallback
     */
    parseFloat(str, fallback = 0) {
        const val = parseFloat(str);
        return isNaN(val) ? fallback : val;
    },

    /**
     * Debounce function execution
     * @param {Function} func - Function to debounce
     * @param {number} wait - Milliseconds to wait
     * @returns {Function} Debounced function
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Throttle function execution
     * @param {Function} func - Function to throttle
     * @param {number} limit - Milliseconds between executions
     * @returns {Function} Throttled function
     */
    throttle(func, limit) {
        let inThrottle;
        return function executedFunction(...args) {
            if (!inThrottle) {
                func(...args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    },

    /**
     * Calculate average of an array of numbers
     * @param {number[]} arr - Array of numbers
     * @returns {number} Average value
     */
    average(arr) {
        if (arr.length === 0) return 0;
        return arr.reduce((sum, val) => sum + val, 0) / arr.length;
    },

    /**
     * Calculate sum of an array of numbers
     * @param {number[]} arr - Array of numbers
     * @returns {number} Sum value
     */
    sum(arr) {
        return arr.reduce((sum, val) => sum + val, 0);
    },

    /**
     * Generate unique array from source array
     * @param {any[]} arr - Array to deduplicate
     * @returns {any[]} Array with unique values
     */
    unique(arr) {
        return [...new Set(arr)];
    },

    /**
     * Group array by key function
     * @param {any[]} arr - Array to group
     * @param {Function} keyFn - Function to extract group key
     * @returns {Object} Object with grouped arrays
     */
    groupBy(arr, keyFn) {
        const result = {};
        arr.forEach(item => {
            const key = keyFn(item);
            if (!result[key]) result[key] = [];
            result[key].push(item);
        });
        return result;
    },

    /**
     * Sort array of objects by property
     * @param {any[]} arr - Array to sort
     * @param {string} prop - Property to sort by
     * @param {string} order - 'asc' or 'desc'
     * @returns {any[]} Sorted array
     */
    sortBy(arr, prop, order = 'asc') {
        return [...arr].sort((a, b) => {
            const valA = a[prop];
            const valB = b[prop];
            
            if (valA < valB) return order === 'asc' ? -1 : 1;
            if (valA > valB) return order === 'asc' ? 1 : -1;
            return 0;
        });
    },

    /**
     * Clamp value between min and max
     * @param {number} value - Value to clamp
     * @param {number} min - Minimum value
     * @param {number} max - Maximum value
     * @returns {number} Clamped value
     */
    clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    },

    /**
     * Round to specified decimal places
     * @param {number} value - Value to round
     * @param {number} decimals - Number of decimal places
     * @returns {number} Rounded value
     */
    round(value, decimals = 0) {
        const factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    },

    /**
     * Format bytes to human readable string
     * @param {number} bytes - Number of bytes
     * @returns {string} Formatted string like "1.5 GB"
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const k = 1024;
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
    },

    /**
     * Copy text to clipboard
     * @param {string} text - Text to copy
     * @returns {Promise<boolean>} Success status
     */
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.error('Failed to copy:', err);
            return false;
        }
    },

    /**
     * Download data as file
     * @param {string} content - File content
     * @param {string} filename - File name
     * @param {string} mimeType - MIME type
     */
    downloadAsFile(content, filename, mimeType = 'text/plain') {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    /**
     * Read file as text
     * @param {File} file - File to read
     * @returns {Promise<string>} File content
     */
    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    },

    /**
     * Safe JSON parse with fallback
     * @param {string} str - JSON string
     * @param {any} fallback - Fallback value
     * @returns {any} Parsed object or fallback
     */
    parseJSON(str, fallback = null) {
        try {
            return JSON.parse(str);
        } catch (e) {
            console.warn('JSON parse failed:', e);
            return fallback;
        }
    },

    /**
     * Format date to ISO string
     * @param {Date} date - Date object
     * @returns {string} ISO formatted string
     */
    formatDate(date) {
        return date instanceof Date ? date.toISOString() : new Date().toISOString();
    },

    /**
     * Get URL query parameter
     * @param {string} name - Parameter name
     * @returns {string|null} Parameter value
     */
    getUrlParam(name) {
        const params = new URLSearchParams(window.location.search);
        return params.get(name);
    },

    /**
     * Set URL query parameter
     * @param {string} name - Parameter name
     * @param {string} value - Parameter value
     */
    setUrlParam(name, value) {
        const url = new URL(window.location.href);
        url.searchParams.set(name, value);
        window.history.replaceState({}, '', url.toString());
    },

    /**
     * Check if element is in viewport
     * @param {HTMLElement} element - Element to check
     * @returns {boolean} True if visible in viewport
     */
    isInViewport(element) {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    },

    /**
     * Get element by ID with error handling
     * @param {string} id - Element ID
     * @returns {HTMLElement|null} Element or null
     */
    getElement(id) {
        const el = document.getElementById(id);
        if (!el) {
            console.warn(`Element not found: ${id}`);
        }
        return el;
    },

    /**
     * Select element by CSS selector
     * @param {string} selector - CSS selector
     * @returns {NodeList|null} NodeList or null
     */
    querySelector(selector) {
        return document.querySelector(selector);
    },

    /**
     * Select all elements by CSS selector
     * @param {string} selector - CSS selector
     * @returns {NodeList} NodeList
     */
    querySelectorAll(selector) {
        return document.querySelectorAll(selector);
    },

    /**
     * Add event listener with cleanup
     * @param {HTMLElement} element - Target element
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     * @returns {Function} Cleanup function
     */
    addEventListener(element, event, handler) {
        element.addEventListener(event, handler);
        return () => element.removeEventListener(event, handler);
    },

    /**
     * Generate unique ID
     * @param {string} prefix - ID prefix
     * @returns {string} Unique ID
     */
    generateId(prefix = 'id') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    },

    /**
     * Base64 encode string
     * @param {string} str - String to encode
     * @returns {string} Base64 encoded string
     */
    base64Encode(str) {
        return btoa(encodeURIComponent(str));
    },

    /**
     * Base64 decode string
     * @param {string} str - String to decode
     * @returns {string} Decoded string
     */
    base64Decode(str) {
        try {
            return decodeURIComponent(atob(str));
        } catch (e) {
            return '';
        }
    },

    /**
     * LocalStorage wrapper with error handling
     */
    storage: {
        get(key, fallback = null) {
            try {
                const item = localStorage.getItem(key);
                return item ? JSON.parse(item) : fallback;
            } catch (e) {
                console.warn('Storage get failed:', e);
                return fallback;
            }
        },

        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
                return true;
            } catch (e) {
                console.warn('Storage set failed:', e);
                return false;
            }
        },

        remove(key) {
            try {
                localStorage.removeItem(key);
                return true;
            } catch (e) {
                console.warn('Storage remove failed:', e);
                return false;
            }
        },

        clear() {
            try {
                localStorage.clear();
                return true;
            } catch (e) {
                console.warn('Storage clear failed:', e);
                return false;
            }
        }
    }
};

// Export for both browser and Node.js
if (typeof window !== 'undefined') {
    window.Utils = Utils;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
}
