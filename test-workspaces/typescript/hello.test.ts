const { strictEqual } = require('node:assert');

// just some typescript code which would be valid directly in Node

function topLevel(a: number): string {
  return a.toString() as string;
}

describe('math', () => {
  function inDescribe(a: number): string {
    return a.toString() as string;
  }

  it('addition', async () => {
    strictEqual(1 + 1 as number, 2 as any as number);
  });

  it(`subtraction`, async () => {
    strictEqual(1 - 1 as number, 0 as any as number);
  });
});