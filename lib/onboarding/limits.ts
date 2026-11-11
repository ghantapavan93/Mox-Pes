/**
 * Resource bounds for one upload. Every limit is enforced before the work it bounds, and a
 * file over any of them is refused with a reason; nothing is truncated silently.
 */
export const LIMITS = {
  /** Bytes of the uploaded file as received. */
  maxUploadBytes: 5 * 1024 * 1024,
  /** Data rows after the header. Profiling covers every row up to this bound. */
  maxRows: 50_000,
  maxColumns: 200,
  maxCellChars: 10_000,
  maxHeaderChars: 200,
  /** XLSX is a zip: bound the archive before inflating any of it. */
  xlsx: {
    maxEntries: 2_000,
    /** Sum of the uncompressed sizes the archive declares, and of what is actually inflated. */
    maxUncompressedBytes: 60 * 1024 * 1024,
    /** A higher ratio is a decompression bomb, not a spreadsheet. */
    maxCompressionRatio: 200,
    maxSheets: 50,
    /** Characters the cells decode to, in total: shared strings can repeat one long string in every cell. */
    maxDecodedChars: 20_000_000,
  },
  /** JSON nesting is flattened to dotted column names up to this depth. */
  maxJsonDepth: 6,
  /** Staged rows are deleted after this long, published or not. */
  retentionHours: 24,
} as const;
