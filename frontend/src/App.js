fetch("http://127.0.0.1:5000/api/customer/TESTVIN123")
  .then(res => res.json())
  .then(data => console.log(data));
