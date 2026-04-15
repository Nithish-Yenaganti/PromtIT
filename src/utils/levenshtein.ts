export function getLevenshteinDistance(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    const matrix = Array.from({ length: len1 + 1 }, () => 
      new Array(len2 + 1).fill(0)
    );
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
          const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
          
          // The '!' tells TypeScript the row definitely exists
          const row = matrix[i]!;
          const prevRow = matrix[i - 1]!;
      
          row[j] = Math.min(
            prevRow[j]! + 1,       // deletion
            row[j - 1]! + 1,       // insertion
            prevRow[j - 1]! + cost // substitution
          );
        }
      }
      // Final safe return
      return matrix[len1]?.[len2] ?? 0;

    }