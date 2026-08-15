type RawDataMatrix = {
  readonly pixs: number[];
  readonly pixx: number;
  readonly pixy: number;
};

function isRawDataMatrix(value: unknown): value is RawDataMatrix {
  return (
    typeof value === "object" &&
    value !== null &&
    "pixs" in value &&
    "pixx" in value &&
    "pixy" in value &&
    Array.isArray(value.pixs) &&
    typeof value.pixx === "number" &&
    typeof value.pixy === "number"
  );
}

function readCodewords(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !isRawDataMatrix(raw[0])) {
    throw new Error("Expected one raw Data Matrix symbol");
  }

  const { pixs, pixx, pixy } = raw[0];
  const rows = pixy - 2;
  const columns = pixx - 2;
  if (rows <= 0 || columns <= 0 || rows !== columns || rows % 2 !== 0) {
    throw new Error("Unsupported Data Matrix symbol geometry");
  }

  const modules = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => pixs[(row + 1) * pixx + column + 1] === 1),
  );
  const visited = Array.from({ length: rows }, () => Array<boolean>(columns).fill(false));
  const codewords: number[] = [];

  const readModule = (inputRow: number, inputColumn: number): boolean => {
    let row = inputRow;
    let column = inputColumn;
    if (row < 0) {
      row += rows;
      column += 4 - ((rows + 4) % 8);
    }
    if (column < 0) {
      column += columns;
      row += 4 - ((columns + 4) % 8);
    }
    const visitedRow = visited[row];
    const moduleRow = modules[row];
    const module = moduleRow?.[column];
    if (visitedRow === undefined || module === undefined) {
      throw new Error("Data Matrix placement falls outside symbol geometry");
    }
    visitedRow[column] = true;
    return module;
  };

  const readUtah = (row: number, column: number): void => {
    const positions: ReadonlyArray<readonly [number, number]> = [
      [row - 2, column - 2],
      [row - 2, column - 1],
      [row - 1, column - 2],
      [row - 1, column - 1],
      [row - 1, column],
      [row, column - 2],
      [row, column - 1],
      [row, column],
    ];
    codewords.push(
      positions.reduce(
        (codeword, [currentRow, currentColumn], index) =>
          codeword | (Number(readModule(currentRow, currentColumn)) << (7 - index)),
        0,
      ),
    );
  };

  const readCorner = (positions: ReadonlyArray<readonly [number, number]>): void => {
    codewords.push(
      positions.reduce(
        (codeword, [row, column], index) =>
          codeword | (Number(readModule(row, column)) << (7 - index)),
        0,
      ),
    );
  };

  const readCorner1 = (): void => {
    readCorner([
      [rows - 1, 0],
      [rows - 1, 1],
      [rows - 1, 2],
      [0, columns - 2],
      [0, columns - 1],
      [1, columns - 1],
      [2, columns - 1],
      [3, columns - 1],
    ]);
  };

  const readCorner2 = (): void => {
    readCorner([
      [rows - 3, 0],
      [rows - 2, 0],
      [rows - 1, 0],
      [0, columns - 4],
      [0, columns - 3],
      [0, columns - 2],
      [0, columns - 1],
      [1, columns - 1],
    ]);
  };

  const readCorner3 = (): void => {
    readCorner([
      [rows - 1, 0],
      [rows - 1, columns - 1],
      [0, columns - 3],
      [0, columns - 2],
      [0, columns - 1],
      [1, columns - 3],
      [1, columns - 2],
      [1, columns - 1],
    ]);
  };

  const readCorner4 = (): void => {
    readCorner([
      [rows - 3, 0],
      [rows - 2, 0],
      [rows - 1, 0],
      [0, columns - 2],
      [0, columns - 1],
      [1, columns - 1],
      [2, columns - 1],
      [3, columns - 1],
    ]);
  };

  let row = 4;
  let column = 0;
  do {
    if (row === rows && column === 0) {
      readCorner1();
    }
    if (row === rows - 2 && column === 0 && columns % 4 !== 0) {
      readCorner2();
    }
    if (row === rows - 2 && column === 0 && columns % 8 === 4) {
      readCorner4();
    }
    if (row === rows + 4 && column === 2 && columns % 8 === 0) {
      readCorner3();
    }
    do {
      if (row < rows && column >= 0 && !visited[row]?.[column]) {
        readUtah(row, column);
      }
      row -= 2;
      column += 2;
    } while (row >= 0 && column < columns);
    row += 1;
    column += 3;
    do {
      if (row >= 0 && column < columns && !visited[row]?.[column]) {
        readUtah(row, column);
      }
      row += 2;
      column -= 2;
    } while (row < rows && column >= 0);
    row += 3;
    column += 1;
  } while (row < rows || column < columns);

  return codewords;
}

const TEXT_SHIFT_2 = "!\"#$%&'()*+,-./:;<=>?@[\\]^_";
const TEXT_SHIFT_3 = "`ABCDEFGHIJKLMNOPQRSTUVWXYZ{|}~\u007f";

function decodeTextCodewords(
  codewords: readonly number[],
  start: number,
  output: string[],
): number {
  let index = start;
  let shift = 0;
  while (index < codewords.length) {
    const first = codewords[index];
    if (first === 254) {
      return index + 1;
    }
    const second = codewords[index + 1];
    if (first === undefined || second === undefined) {
      throw new Error("Incomplete Data Matrix text codeword pair");
    }
    index += 2;
    const packed = (first << 8) + second - 1;
    const values = [Math.floor(packed / 1600), Math.floor((packed % 1600) / 40), packed % 40];
    for (const value of values) {
      if (shift === 1) {
        output.push(String.fromCharCode(value));
        shift = 0;
        continue;
      }
      if (shift === 2) {
        const character = TEXT_SHIFT_2[value];
        if (character === undefined) {
          throw new Error(`Unsupported Data Matrix text shift-2 value ${value}`);
        }
        output.push(character);
        shift = 0;
        continue;
      }
      if (shift === 3) {
        const character = TEXT_SHIFT_3[value];
        if (character === undefined) {
          throw new Error(`Unsupported Data Matrix text shift-3 value ${value}`);
        }
        output.push(character);
        shift = 0;
        continue;
      }
      if (value <= 2) {
        shift = value + 1;
      } else if (value === 3) {
        output.push(" ");
      } else if (value <= 13) {
        output.push(String.fromCharCode("0".charCodeAt(0) + value - 4));
      } else {
        output.push(String.fromCharCode("a".charCodeAt(0) + value - 14));
      }
    }
  }
  return index;
}

export function decodeDataMatrixAscii(raw: unknown): string {
  const output: string[] = [];
  const codewords = readCodewords(raw);
  for (let index = 0; index < codewords.length; index += 1) {
    const codeword = codewords[index];
    if (codeword === undefined) {
      break;
    }
    if (codeword === 129) {
      break;
    }
    if (codeword >= 1 && codeword <= 128) {
      output.push(String.fromCharCode(codeword - 1));
      continue;
    }
    if (codeword >= 130 && codeword <= 229) {
      output.push(String(codeword - 130).padStart(2, "0"));
      continue;
    }
    if (codeword === 239) {
      index = decodeTextCodewords(codewords, index + 1, output) - 1;
      continue;
    }
    throw new Error(`Unsupported Data Matrix codeword ${codeword}`);
  }
  return output.join("");
}
