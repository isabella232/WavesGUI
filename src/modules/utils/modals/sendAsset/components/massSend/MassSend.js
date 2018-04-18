(function () {
    'use strict';

    /**
     * @param {Base} Base
     * @param {ReadFile} readFile
     * @param {$rootScope.Scope} $scope
     * @param {app.utils} utils
     * @param {ValidateService} validateService
     * @param {Waves} waves
     * @param {User} user
     * @return {MassSend}
     */
    const controller = function (Base, readFile, $scope, utils, validateService, waves, user) {

        const Papa = require('papaparse');
        const TYPE = WavesApp.TRANSACTION_TYPES.NODE.MASS_TRANSFER;

        class MassSend extends Base {

            /**
             * @return {IMassSendTx}
             */
            get tx() {
                return this.state.massSend;
            }

            get isValidCSV() {
                return this._isValidAmounts && this.totalAmount && this.totalAmount.getTokens().gt(0) || false;
            }

            constructor() {
                super();
                /**
                 * @type {ISendState}
                 */
                this.state = null;
                /**
                 * @type {number}
                 */
                this.maxTransfersCount = 100;
                /**
                 * @type {Function}
                 */
                this.onContinue = null;
                /**
                 * @type {string}
                 */
                this.recipientCsv = '';
                /**
                 * @type {Money}
                 */
                this.totalAmount = null;
                /**
                 * @type {Array<{recipient: string, type: string}>}
                 */
                this.errors = [];
                /**
                 * @type {boolean}
                 * @private
                 */
                this._isValidAmounts = true;
                /**
                 * @type {Money}
                 * @private
                 */
                this._transferFee = null;
                /**
                 * @type {Money}
                 * @private
                 */
                this._massTransferFee = null;
            }

            $postLink() {
                this.tx.transfers = this.tx.transfers || [];

                const signal = utils.observe(this.state.massSend, 'transfers');

                this.receive(signal, this._calculateTotalAmount, this);
                this.receive(signal, this._calculateFee, this);
                this.receive(signal, this._updateTextAreaContent, this);
                this.observe('recipientCsv', this._onChangeCSVText);

                signal.dispatch({ value: this.tx.transfers });
            }

            /**
             * @param {ImportFile#IOnChangeOptions} data
             */
            importFile(data) {
                if (data.status === 'ok') {
                    return readFile.read(data.file)
                        .then((content) => {
                            this._processTextAreaContent(content);
                            $scope.$digest();
                        });
                } else {
                    // todo show import file error
                }
            }

            clear() {
                this.tx.transfers = [];
            }

            nextStep() {

                const tx = waves.node.transactions.createTransaction(TYPE, {
                    ...this.tx,
                    sender: user.address
                });

                this.onContinue({ tx });
            }

            /**
             * @private
             */
            _calculateTotalAmount() {
                const transfers = this.tx.transfers;

                if (!transfers) {
                    this.totalAmount = null;
                }

                if (transfers.length) {
                    this.totalAmount = this.tx.transfers
                        .map(({ amount }) => amount)
                        .reduce((result, item) => result.add(item));

                    return null;
                }

                this.totalAmount = this.state.moneyHash[this.state.assetId].cloneWithTokens('0');
            }

            /**
             * @private
             */
            _calculateFee() {
                waves.node.getFee({ type: TYPE, tx: this.tx }).then((fee) => {
                    this.tx.fee = fee;
                });
            }

            /**
             * @param {string} content
             * @private
             */
            _processTextAreaContent(content) {
                const { data } = Papa.parse(content);
                const recipientHash = MassSend._getRecipientHashByCSVParseResult(data);
                const errors = [];
                const transfers = [];

                Object.keys(recipientHash).forEach((recipient) => {
                    const amountNum = recipientHash[recipient]
                        .map((amount) => {
                            try {
                                return MassSend._parseAmount(amount);
                            } catch (e) {
                                errors.push({ recipient, type: 'amount' });
                                return new BigNumber(0);
                            }
                        })
                        .reduce((result, item) => result.add(item));
                    const amount = this.state.moneyHash[this.state.assetId].cloneWithTokens(amountNum);
                    transfers.push({ recipient, amount });
                });

                if (MassSend._isNotEqual(this.tx.transfers, transfers)) {
                    this.errors = errors;
                    this.tx.transfers = transfers;
                }
            }

            _validate() {
                this._validateAmounts();
                this._validateRecipients();
            }

            /**
             * @private
             */
            _validateRecipients() {

                const isValidRecipient = function ({ recipient }) {
                    return utils.resolve(validateService.wavesAddress(recipient));
                };

                Promise.all(this.tx.transfers.map(isValidRecipient))
                    .then((list) => {
                        const errors = [];

                        list.forEach((state, index) => {
                            const recipient = this.tx.transfers[index].recipient;

                            if (!state) {
                                errors.push({ recipient, type: 'recipient' });
                            }
                        });

                        if (errors.length) {
                            this.errors.push(...errors);
                            $scope.$digest();
                        }
                    });
            }

            /**
             * @private
             */
            _validateAmounts() {
                const moneyHash = utils.groupMoney([this.totalAmount, this.tx.fee]);
                const balance = moneyHash[this.state.assetId];
                this._isValidAmounts = this.state.moneyHash[this.state.assetId].gte(balance);
            }

            /**
             * @private
             */
            _onChangeCSVText() {
                const text = this.recipientCsv;
                this._processTextAreaContent(text);
                this._validate();
            }

            /**
             * @private
             */
            _updateTextAreaContent() {
                const transfers = this.tx.transfers;
                const text = transfers.reduce((text, item, index) => {
                    const prefix = index !== 0 ? '\n' : '';
                    return `${text}${prefix}${item.recipient}, "${item.amount.toFormat()}"`;
                }, '');
                if (text !== this.recipientCsv) {
                    this.recipientCsv = text;
                }
            }

            /**
             * @param {Array<Array<string>>} data
             * @return {Object.<string, Array<string>>}
             * @private
             */
            static _getRecipientHashByCSVParseResult(data) {
                const recipientHash = Object.create(null);
                data.forEach((item) => {
                    if (!item.length) {
                        return null;
                    }

                    const [recipient, amountString] = item.map((text) => text.replace(/\s/g, '').replace(/"/g, ''));
                    if (!(recipient && amountString)) {
                        return null;
                    }

                    if (!recipientHash[recipient]) {
                        recipientHash[recipient] = [];
                    }

                    recipientHash[recipient].push(amountString);
                });
                return recipientHash;
            }

            /**
             * @param {ITransferItem[]} a
             * @param {ITransferItem[]} b
             * @return {boolean}
             * @private
             */
            static _isNotEqual(a, b) {
                return !MassSend._isEqual(a, b);
            }

            /**
             * @param {ITransferItem[]} a
             * @param {ITransferItem[]} b
             * @return {boolean}
             * @private
             */
            static _isEqual(a, b) {
                return a.length === b.length && a.every((item, i) => {
                    return item.recipient === b[i].recipient && item.amount.eq(b[i].amount);
                });
            }

            /**
             * @param {string} amountString
             * @return {BigNumber}
             * @private
             */
            static _parseAmount(amountString) {
                const amount = amountString
                    .replace(/\s/g, '')
                    .replace(/,/, '.');
                return new BigNumber(amount);
            }

        }

        return new MassSend();
    };

    controller.$inject = ['Base', 'readFile', '$scope', 'utils', 'validateService', 'waves', 'user'];

    angular.module('app.ui').component('wMassSend', {
        bindings: {
            state: '<',
            onContinue: '&'
        },
        templateUrl: 'modules/utils/modals/sendAsset/components/massSend/mass-send.html',
        transclude: true,
        controller
    });
})();
