export const magicbytes: Uint8Array = new Uint8Array([0x66, 0x67, 0x67, 0x01, 0x66, 0x67, 0x67, 0x00]);
export const fgbMagicBytes: Uint8Array = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);
export const SIZE_PREFIX_LEN = 4;

export function isValidMagicBytes(bytes: Uint8Array): boolean {
    const fgg = bytes[0] === 0x66 && bytes[1] === 0x67 && bytes[2] === 0x67;
    const fgb = bytes[0] === 0x66 && bytes[1] === 0x67 && bytes[2] === 0x62;
    return fgg || fgb;
}
