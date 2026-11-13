# Older changes
## 3.0.2 (2026-11-03)
- (copilot) Adapter requires node.js >= 22.19.0 now
- (ioBroker-Bot) Adapter requires js-controller >= 6.0.11 now.
- (bluefox) Fixed parsing of logic operation (SUM) status messages. Invalid objects like `SUMS.SUMSUM1000_undefined` were created, and the adapter ran into an endless loop with high CPU load. The invalid objects are deleted on start. New states are `SUMS.SUM01`...`SUMS.SUM04`.
- (bluefox) Migrated the GitHub workflow to the ioBroker testing actions with npm trusted publishing
- (bluefox) Removed unused dependency `jsonwebtoken` and modernized the code

## 3.0.1 (2025-03-24)
* (bluefox) License was changed to MIT. The adapter is now free of charge.

## 2.0.3 (2024-09-04)
* (bluefox) Added translations

## 2.0.2 (2024-09-03)
* (bluefox) Corrected checking of licenses with license manager

## 2.0.1 (2024-08-07)
* (bluefox) Disable possibility to install via git

## 2.0.0 (2024-08-06)
* (bluefox) Made adapter compatible with js-controller 6
* (bluefox) A minimum supported node.js version is 18

## 1.1.8 (2023-11-13)
* (bluefox) Added SUM inputs

## 1.1.7 (2023-11-06)
* (bluefox) Corrected setting of undefined values

## 1.1.1 (2022-10-19)
* (bluefox) Corrected license check

## 1.1.0 (2022-10-18)
* (bluefox) Corrected issue with password

## 1.0.4 (2021-05-21)
* (bluefox) Ack will be ignored for the display commands

## 1.0.3 (2021-05-21)
* (bluefox) Changed the calculation of the temperature variables

## 1.0.2 (2020-10-11)
* (bluefox) Implemented the regulators and the display support.

## 0.6.3 (2019-12-18)
* (bluefox) General relays mode implemented

## 0.6.2 (2019-12-07)
* (bluefox) Detected delayed responses
* (bluefox) Dynamical creation of states is implemented

## 0.5.5 (2019-12-05)
* (bluefox) Relay inputs were corrected

## 0.5.4 (2019-12-04)
* (bluefox) Connection indication was corrected

## 0.5.1 (2019-11-29)
* (bluefox) Finger scanner supported
* (bluefox) Added possibility to set the analog mode
* (bluefox) Relay outputs are supported now

## 0.4.4 (2019-11-26)
* (bluefox) Fixed error by parsing of acknowledgement

## 0.4.2 (2019-06-12)
* (bluefox) Support of old measure values was added

## 0.3.2 (2018-11-19)
* (bluefox) add variables support

## 0.2.1
* (bluefox) initial release
