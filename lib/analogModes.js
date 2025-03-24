const ANALOG_MODES = {
    DEFAULT: 1,
    IOB100toLCN50: 1, // !OM0P - Output-Mode 0..50 percent
    // IOB 0-100% <=> 0-50 (LCN-PCK)
    IOB50toLCN50: 2, // !OM0N - Output-Mode 0..50 native
    // IOB 0-50 <=> 0-50 (LCN-PCK)
    IOB100toLCN200: 3, // !OM1P - Output-Mode 0..200 percent
    // IOB 0-100 <=> 0-200 (LCN-PCK)
    IOB200toLCN200: 4, // !OM1N - Output-Mode 0..200 native
    // IOB 0-200 <=> 0-200 (LCN-PCK)
};
module.exports = ANALOG_MODES;
