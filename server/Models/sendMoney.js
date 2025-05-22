const mongoose = require('mongoose');

const sendMoneySchema = new mongoose.Schema({
  from: {
    type: String,
    required: true,
  },
  recipient_account: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  note: {
    type: String,
  },
  recipient_name: {
    type: String,
    default: null, // Optional field for non-registered recipients
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    required: true,
  },
}, { timestamps: true }); // Adds createdAt and updatedAt fields

const SendMoney = mongoose.model('sendMoney', sendMoneySchema);

module.exports = SendMoney;