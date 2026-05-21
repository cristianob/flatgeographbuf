export const magicbytes: Uint8Array = new Uint8Array([0x66, 0x67, 0x67, 0x02, 0x66, 0x67, 0x67, 0x00]);
export const fgbMagicBytes: Uint8Array = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);
export const SIZE_PREFIX_LEN = 4;

/** Validate that the leading bytes identify a FlatGeoGraphBuf file
 *  with the current major version (byte 3 = 0x02). Future readers may
 *  accept additional majors; today only 0x02 is supported. */
export function isValidMagicBytes(bytes: Uint8Array): boolean {
    return (
        bytes.byteLength >= 4 &&
        bytes[0] === 0x66 &&
        bytes[1] === 0x67 &&
        bytes[2] === 0x67 &&
        bytes[3] === 0x02
    );
}
