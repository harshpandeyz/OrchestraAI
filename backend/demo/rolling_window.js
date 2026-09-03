'use strict';

// Rolling window utilities for health/performance tracking.

class RollingWindow {
  constructor(size) {
    this.size = size;
    this.data = [];
  }

  add(value) {
    this.data.push(value);
    if (this.data.length > this.size) {
      this.data = this.data.slice(-this.size);
    }
  }

  get mean() {
    if (this.data.length === 0) return 0;
    return this.data.reduce((a, b) => a + b, 0) / this.data.length;
  }

  get median() {
    if (this.data.length === 0) return 0;
    const sorted = [...this.data].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  get count() {
    return this.data.length;
  }

  get last() {
    return this.data[this.data.length - 1] || null;
  }

  get standardDeviation() {
    if (this.data.length < 2) return 0;
    const mean = this.mean;
    const squared = this.data.map(v => Math.pow(v - mean, 2));
    return Math.sqrt(squared.reduce((a, b) => a + b, 0) / this.data.length);
  }

  get min() {
    if (this.data.length === 0) return null;
    return Math.min(...this.data);
  }

  get max() {
    if (this.data.length === 0) return null;
    return Math.max(...this.data);
  }
}

module.exports = { RollingWindow };