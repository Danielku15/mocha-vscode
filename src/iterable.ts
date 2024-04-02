/**
 * Copyright (C) Daniel Kuschny (Danielku15) and contributors.
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 */

export const last = <T>(it: Iterable<T>): T | undefined => {
  let last: T | undefined;
  for (const item of it) {
    last = item;
  }
  return last;
};
